import type { ToolDeps } from "../types"
import { generateId, validateMemberName } from "../util"
import { findTeamBySession } from "../types"

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent: string; prompt: string; model?: string; claim_task?: string },
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

  // Create child session via SDK
  const createResult = await deps.client.session.create({
    body: { parentID: sessionId, title: `${args.name} (@${args.agent} teammate)` },
  })
  const childSessionId = createResult.data?.id
  if (!childSessionId) throw new Error("Failed to create teammate session")

  // Register in DB
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?)`,
    [teamInfo.teamId, args.name, childSessionId, args.agent, args.model ?? null, args.prompt, now, now]
  )

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Build teammate context message per AGENTS.md Teammate Context Message Design
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${args.agent}".`,
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
  ]

  if (args.claim_task) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Fire-and-forget: send prompt to teammate session
  // OQ-1: confirmed — promptAsync queues when session is busy (verified in live testing)
  // OQ-10: confirmed — fresh session accepts promptAsync without session.init() (verified in live testing)
  try {
    await deps.client.session.promptAsync({
      path: { id: childSessionId },
      body: { parts: [{ type: "text", text: contextStr }] },
    })
  } catch (err) {
    // Rollback: clean up DB, registry, and abort the orphaned session
    deps.db.run("DELETE FROM team_member WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.name])
    deps.registry.unregister(childSessionId)
    try { await deps.client.session.abort({ path: { id: childSessionId } }) } catch { /* best effort */ }
    throw new Error(`Failed to send initial prompt to teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  return `Teammate "${args.name}" spawned (agent: ${args.agent}). They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}
