import type { Database } from "bun:sqlite"
import { markDelivered } from "./messaging"
import { parseTaskResult, formatTaskResult } from "./result-parser"
import type { EnsembleConfig } from "./config"

/** Truncate a string to maxLen chars, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s
}

/** Status display mapping from DB status to human-readable label. */
const STATUS_DISPLAY: Record<string, string> = {
  busy: "working",
  ready: "idle",
  shutdown_requested: "shutting down",
  shutdown: "shut down",
  error: "error",
}

/**
 * Build the system prompt injected into the lead's session.
 * Includes team name, member statuses, task counts, and anti-polling guidance.
 */
export function buildLeadSystemPrompt(db: Database, teamId: string, config?: Required<EnsembleConfig>): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const pending = countMap.pending ?? 0

  const memberList = members
    .map((m) => `${m.name} [${STATUS_DISPLAY[m.status] ?? m.status}]`)
    .join(", ")

  const teammateLine = members.length > 0
    ? `Teammates: ${memberList}`
    : "Teammates: none"

  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId) as Array<{ id: string; from_name: string; content: string }>

  const lines = [
    `You are leading team "${team.name}" with ${members.length} active teammates.`,
    teammateLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
  ]

  // Inline active and recently completed tasks
  const activeTasks = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'in_progress' ORDER BY time_updated DESC LIMIT 5"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  const recentCompleted = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 3"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  if (activeTasks.length > 0) {
    lines.push("Active tasks:")
    for (const t of activeTasks) {
      lines.push(`  [in_progress] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }
  if (recentCompleted.length > 0) {
    lines.push("Recently completed:")
    for (const t of recentCompleted) {
      lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }

  if (pendingMessages.length > 0) {
    lines.push("", "--- Team Messages ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        // Truncate details for system prompt — full content available via team_results
        const truncatedResult = { ...parsed, details: truncate(parsed.details, 500) }
        lines.push(formatTaskResult(msg.from_name, truncatedResult))
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (use team_results to read full message)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  // Model selection guidance (only when promptForModels is enabled)
  if (config?.promptForModels) {
    const poolOptions = (config.modelPool && config.modelPool.length > 0)
      ? config.modelPool.map(m => `      { label: "${m}", description: "" }`).join(",\n")
      : ""
    lines.push(
      "",
      "MODEL SELECTION:",
      "Before spawning teammates, use the question tool to ask the user about model preferences.",
      "Do NOT spawn any agents until the user confirms their model preference.",
      "Keep descriptions simple and clear — explain what each option means in plain language.",
      "Example question tool call:",
      '  question({ questions: [{ question: "Which AI models should your team agents use?", header: "Agent models", options: [',
      '    { label: "Same as me (Recommended)", description: "Every agent uses the same model I\'m running on. Simplest option — no extra setup needed." },',
      '    { label: "Mix of models", description: "Each agent gets a different model from your configured pool. Useful for getting diverse perspectives on the same problem." },',
      '    { label: "I\'ll choose per agent", description: "You pick the exact model for each agent as I spawn them. Most control, but requires a choice per agent." }',
      "  ]}]})",
    )
    if (poolOptions) {
      lines.push(
        'If user picks "Mix of models", ask which models with multiple: true:',
        "  question({ questions: [{ question: \"Which models should agents rotate through? Pick all that apply.\", header: \"Model pool\", multiple: true, options: [",
        poolOptions,
        "  ]}]})",
      )
    }
    lines.push(
      'If user picks "I\'ll choose per agent", ask for each agent\'s model individually before each team_spawn call.',
      "Pass the chosen model via the model parameter on each team_spawn call.",
    )
  }

  lines.push(
    "",
    "Spawn teammates ONE AT A TIME. Wait for each tool result before spawning the next.",
    "This avoids git worktree contention. Once all are spawned, wait for their messages.",
    "",
    "Teammates work asynchronously and message you when done.",
    "Do NOT poll team_status or team_tasks_list repeatedly — wait for messages.",
    "After spawning all teammates, tell the user what you've set up and wait.",
    "When all teammates finish, summarize results and suggest next steps.",
    "",
    "MERGE WORKFLOW:",
    "After a teammate finishes and you shut them down, use team_merge to merge their branch.",
    "Do NOT tell teammates to commit — they handle that themselves.",
    "Do NOT run git merge manually — use team_merge which squash-merges and unstages for you.",
    "team_cleanup will safety-net merge any branches you forgot, but prefer explicit team_merge.",
    "",
    "Before calling team_cleanup, verify teammates have committed their work.",
    "team_shutdown will warn you if a teammate has uncommitted changes.",
    "team_cleanup will block if any worktree has uncommitted changes — merge or commit first.",
  )

  return lines.join("\n")
}

/**
 * Build the system prompt injected into a teammate's session.
 * Includes role reminder and delivers any pending peer messages.
 */
export function buildTeammateSystemPrompt(db: Database, teamId: string, memberName: string): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const lines = [
    `You are "${memberName}", a teammate in team "${team.name}". Use team_message to communicate. You MUST send your results to the lead via team_message before stopping.`,
  ]

  // Deliver pending peer messages addressed to this teammate
  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId, memberName) as Array<{ id: string; from_name: string; content: string }>

  if (pendingMessages.length > 0) {
    lines.push("", "--- Messages for you ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        lines.push(formatTaskResult(msg.from_name, { ...parsed, details: truncate(parsed.details, MAX_MSG) }))
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (truncated)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  return lines.join("\n")
}

/**
 * Build a concise context string for compaction.
 * Includes team name, member statuses, task progress, and role statement.
 */
export function buildTeamCompactionContext(
  db: Database,
  teamId: string,
  role: "lead" | "member",
  memberName?: string,
): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const pending = countMap.pending ?? 0

  const roleLine = role === "lead"
    ? `[Team Context] You are the lead of team "${team.name}".`
    : `[Team Context] You are a teammate named "${memberName}" in team "${team.name}".`

  const memberList = members
    .map((m) => `${m.name} (${STATUS_DISPLAY[m.status] ?? m.status})`)
    .join(", ")

  const membersLine = members.length > 0
    ? `Members: ${memberList}`
    : "Members: none"

  const lines = [
    roleLine,
    membersLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
  ]

  if (role === "member" && memberName) {
    lines.push("IMPORTANT: You MUST send your results to the lead via team_message before stopping.")

    // Include original task prompt
    const member = db.query("SELECT prompt FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamId, memberName) as { prompt: string | null } | null
    if (member?.prompt) {
      lines.push(`Your original task: ${truncate(member.prompt, 300)}`)
    }

    // Include recent messages involving this member
    const recentMsgs = db.query(
      "SELECT from_name, content FROM team_message WHERE team_id = ? AND (from_name = ? OR to_name = ?) ORDER BY time_created DESC LIMIT 3"
    ).all(teamId, memberName, memberName) as Array<{ from_name: string; content: string }>
    if (recentMsgs.length > 0) {
      lines.push("Recent context:")
      for (const msg of recentMsgs) {
        lines.push(`  [${msg.from_name}]: ${truncate(msg.content, 200)}`)
      }
    }
  } else if (role === "member") {
    lines.push("IMPORTANT: You MUST send your results to the lead via team_message before stopping.")
  }

  if (role === "lead") {
    // Include recently completed tasks
    const completedTasks = db.query(
      "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 5"
    ).all(teamId) as Array<{ content: string; assignee: string | null }>
    if (completedTasks.length > 0) {
      lines.push("Recently completed:")
      for (const t of completedTasks) {
        lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` (by ${t.assignee})` : ""}`)
      }
    }
  }

  return lines.join("\n")
}
