import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 * Sets status to shutdown_requested and calls abort. The event hook
 * transitions to shutdown when the session becomes idle.
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

  // Call abort on the member's session
  await deps.client.session.abort({ path: { id: member.session_id } })

  return `Shutdown requested for ${args.member}. Will complete when current work finishes.`
}
