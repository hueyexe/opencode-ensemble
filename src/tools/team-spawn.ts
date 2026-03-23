import type { ToolDeps, PermissionRule } from "../types"
import { generateId, validateMemberName } from "../util"
import { findTeamBySession } from "../types"
import path from "path"

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 * Pass plan_approval: true to require the teammate to send a plan before writing.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent: string; prompt: string; model?: string; claim_task?: string; worktree?: boolean; plan_approval?: boolean },
  sessionId: string,
): Promise<string> {
  const nameError = validateMemberName(args.name)
  if (nameError) throw new Error(nameError)

  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can spawn teammates.")

  // Check duplicate name
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.name)
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`)

  const useWorktree = args.worktree !== false
  const usePlanApproval = args.plan_approval === true

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null

  if (useWorktree) {
    const worktreeName = `ensemble-${teamInfo.teamName}-${args.name}`
    try {
      const result = await deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } })
      if (result.data) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
      }
    } catch {
      // Worktree creation failed — fall back to shared directory with a warning
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}, using shared directory`,
          variant: "warning",
          duration: 4000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  // Belt-and-suspenders: permission rules on session.create are the hard gate (server-enforced),
  // while tools restriction on promptAsync is a soft gate (model-level). Both are needed because
  // permission rules may not survive session restarts, and tools restriction alone is advisory.
  // Only OpenCode's built-in read-only agent modes get restrictions; custom agent names get full access.
  const isReadOnly = args.agent === "plan" || args.agent === "explore"
  const permission: PermissionRule[] | undefined = isReadOnly
    ? [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
      ]
    : undefined

  // Create child session — use worktree directory if available
  let childSessionId: string | undefined
  try {
    const createResult = await deps.client.session.create({
      parentID: sessionId,
      title: `${args.name} (@${args.agent} teammate)`,
      ...(permission ? { permission } : {}),
      ...(worktreeDir ? { directory: worktreeDir } : {}),
    })
    childSessionId = createResult.data?.id
  } catch (err) {
    // Rollback worktree if session creation failed
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!childSessionId) {
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, plan_approval, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?, ?)`,
    [teamInfo.teamId, args.name, childSessionId, args.agent, args.model ?? null, args.prompt, worktreeDir, worktreeBranch, planApproval, now, now]
  )

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${args.agent}".`,
  ]

  if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}" in your own worktree. Your changes are isolated from other teammates.`)
  }

  // Plan approval mode — teammate must send plan before writing
  if (usePlanApproval) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
    )
  }

  context.push(
    "",
    "Tools available to you:",
    "- team_message: send a message to the lead or another teammate",
    "- team_broadcast: send a message to all team members",
    "- team_tasks_list: view the shared team task board",
    "- team_tasks_add: add tasks to the shared board",
    "- team_tasks_complete: mark a task complete on the shared board",
    "- team_claim: claim a pending task from the shared board",
    "",
    "When you finish your task:",
    "1. If you claimed a task, mark it complete using team_tasks_complete.",
    "2. Send ONE message to the lead with your findings using team_message.",
    "3. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.",
    "",
    "If you are blocked, send ONE message to the lead describing the specific blocker.",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate.",
  )

  // Load project AGENTS.md if it exists
  try {
    const agentsPath = path.join(deps.directory, "AGENTS.md")
    const file = Bun.file(agentsPath)
    if (await file.exists()) {
      const content = await file.text()
      const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content
      context.push("", "Project guidelines (from AGENTS.md):", truncated)
    }
  } catch { /* file may not exist or be unreadable */ }

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (args.claim_task) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Fire-and-forget: send prompt to teammate session
  // Pass agent type + disable write tools for read-only agents
  const readOnlyTools: Record<string, boolean> | undefined = isReadOnly
    ? { edit: false, bash: false, team_message: true, team_broadcast: true, team_tasks_list: true, team_tasks_add: true, team_tasks_complete: true, team_claim: true }
    : undefined

  try {
    await deps.client.session.promptAsync({
      sessionID: childSessionId,
      parts: [{ type: "text", text: contextStr }],
      agent: args.agent,
      ...(readOnlyTools ? { tools: readOnlyTools } : {}),
    })
  } catch (err) {
    // Rollback: clean up DB, registry, session, and worktree
    deps.db.run("DELETE FROM team_member WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.name])
    deps.registry.unregister(childSessionId)
    try { await deps.client.session.abort({ sessionID: childSessionId }) } catch { /* best effort */ }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to send initial prompt to teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  const planInfo = usePlanApproval ? " [plan mode — will send plan for approval]" : ""
  return `Teammate "${args.name}" spawned (agent: ${args.agent})${branchInfo}${planInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}
