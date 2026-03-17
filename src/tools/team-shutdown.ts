import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 * Sets status to shutdown_requested, calls abort, then polls session status.
 * If the session is already idle after abort, transitions directly to shutdown.
 * Otherwise the event hook handles the transition when the session goes idle.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: { member: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can shut down teammates.")

  const member = deps.db.query("SELECT session_id, status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") throw new Error(`Teammate "${args.member}" is already shut down`)

  // Set to shutdown_requested
  deps.db.run(
    "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamInfo.teamId, args.member]
  )

  // Call abort on the member's session (best effort)
  try {
    await deps.client.session.abort({ path: { id: member.session_id } })
  } catch {
    // Abort failed — session may already be gone. Fire a warning toast.
    try {
      await deps.client.tui.showToast({
        title: "Team",
        message: `Failed to abort ${args.member} session — will rely on event hook`,
        variant: "warning",
        duration: 4000,
      })
    } catch { /* TUI may not be available */ }
  }

  // Fallback: poll session status after abort. If already idle, transition
  // directly to shutdown. This handles the case where abort() on an
  // already-idle session doesn't fire a session.status event.
  try {
    const statuses = await deps.client.session.status()
    const sessionStatus = statuses.data?.[member.session_id]
    if (!sessionStatus || sessionStatus.type === "idle") {
      deps.db.run(
        "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), teamInfo.teamId, args.member]
      )
      return `Teammate "${args.member}" has been shut down.`
    }
  } catch {
    // Status poll failed — fall through to eventual consistency
  }

  return `Shutdown requested for ${args.member}. Will complete when current work finishes.`
}
