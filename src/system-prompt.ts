import type { Database } from "bun:sqlite"
import { markDelivered } from "./messaging"

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
export function buildLeadSystemPrompt(db: Database, teamId: string): string {
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

  if (pendingMessages.length > 0) {
    lines.push("", "--- Team Messages ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (use team_results to read full message)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  lines.push(
    "",
    "CRITICAL: Spawn teammates ONE AT A TIME. Send only ONE team_spawn call per response.",
    "Wait for the tool result before spawning the next teammate.",
    "Multiple team_spawn calls in a single response will cause timeouts.",
    "",
    "Teammates work asynchronously and message you when done.",
    "Do NOT poll team_status or team_tasks_list repeatedly — wait for messages.",
    "After spawning all teammates, tell the user what you've set up and wait.",
    "When all teammates finish, summarize results and suggest next steps.",
    "",
    "Before calling team_cleanup, verify teammates have committed their work.",
    "team_shutdown will warn you if a teammate has uncommitted changes.",
    "team_cleanup will block if any worktree has uncommitted changes — merge or commit first.",
  )

  return lines.join("\n")
}

/**
 * Build the system prompt injected into a teammate's session.
 * Short role reminder with name, team name, and communication tool.
 */
export function buildTeammateSystemPrompt(db: Database, teamId: string, memberName: string): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  return `You are "${memberName}", a teammate in team "${team.name}". Use team_message to communicate. You MUST send your results to the lead via team_message before stopping.`
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

  if (role === "member") {
    lines.push("IMPORTANT: You MUST send your results to the lead via team_message before stopping.")
  }

  return lines.join("\n")
}
