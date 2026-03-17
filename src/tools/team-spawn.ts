import type { ToolDeps } from "../types"
import { generateId, validateMemberName } from "../util"
import { findTeamBySession } from "../types"

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent: string; prompt: string; model?: string; claim_task?: string; worktree?: boolean },
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

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null

  if (useWorktree) {
    const worktreeName = `ensemble-${teamInfo.teamName}-${args.name}`
    try {
      const result = await deps.client.worktree.create({ name: worktreeName })
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

  // Create child session — use worktree directory if available
  const createOpts: Record<string, unknown> = {
    body: { parentID: sessionId, title: `${args.name} (@${args.agent} teammate)` },
  }
  if (worktreeDir) {
    createOpts.directory = worktreeDir
  }

  let childSessionId: string | undefined
  try {
    const createResult = await deps.client.session.create(createOpts as Parameters<typeof deps.client.session.create>[0])
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
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?)`,
    [teamInfo.teamId, args.name, childSessionId, args.agent, args.model ?? null, args.prompt, worktreeDir, worktreeBranch, now, now]
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
    "",
    "Your task:",
    args.prompt,
  )

  if (args.claim_task) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Fire-and-forget: send prompt to teammate session
  try {
    await deps.client.session.promptAsync({
      path: { id: childSessionId },
      body: { parts: [{ type: "text", text: contextStr }] },
    })
  } catch (err) {
    // Rollback: clean up DB, registry, session, and worktree
    deps.db.run("DELETE FROM team_member WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.name])
    deps.registry.unregister(childSessionId)
    try { await deps.client.session.abort({ path: { id: childSessionId } }) } catch { /* best effort */ }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to send initial prompt to teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  return `Teammate "${args.name}" spawned (agent: ${args.agent})${branchInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}
