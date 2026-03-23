import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 *
 * Graceful negotiation flow:
 * - If member is already shutdown_requested, treat as force (second call).
 * - If member is idle or force=true, abort immediately and set status='shutdown'.
 * - If member is busy and force=false, send a shutdown message via promptAsync
 *   and set status='shutdown_requested'. The member finishes work and reports back.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: { member: string; force?: boolean },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can shut down teammates.")

  const member = deps.db.query("SELECT session_id, status, worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string; worktree_branch: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") throw new Error(`Teammate "${args.member}" is already shut down`)

  const force = args.force ?? false

  // Second call on an already-requested member → force abort
  if (member.status === "shutdown_requested") {
    await abortAndShutdown(deps, teamInfo.teamId, args.member, member.session_id)
    const branchInfo = member.worktree_branch ? ` Changes on branch: ${member.worktree_branch}` : ""
    return `Force shut down "${args.member}".${branchInfo}`
  }

  // Determine if member is idle or busy
  let isIdle = false
  try {
    const statuses = await deps.client.session.status()
    const sessionStatus = statuses.data?.[member.session_id]
    isIdle = !sessionStatus || sessionStatus.type === "idle"
  } catch {
    // Status poll failed — assume busy, fall through to graceful path
  }

  if (isIdle || force) {
    await abortAndShutdown(deps, teamInfo.teamId, args.member, member.session_id)
    const branchInfo = member.worktree_branch ? ` Changes on branch: ${member.worktree_branch}` : ""
    return `Teammate "${args.member}" has been shut down.${branchInfo}`
  }

  // Busy + not force → graceful: send shutdown message, set shutdown_requested
  try {
    await deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{
        type: "text",
        text: `[Shutdown requested]: The lead has requested you shut down. Finish your current task, send your final findings to the lead via team_message, then stop.`,
      }],
    })
  } catch {
    // promptAsync failed — best effort
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamInfo.teamId, args.member],
  )

  return `Shutdown requested for ${args.member}. They will finish current work and shut down. Call team_shutdown with force: true to abort immediately.`
}

/**
 * Abort a member's session and set their status to shutdown.
 * Best-effort: if abort fails, we still mark them as shutdown.
 */
async function abortAndShutdown(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
): Promise<void> {
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch {
    // Abort failed — session may already be gone
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName],
  )
}
