import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_view tool. Navigates the TUI to a teammate's session
 * so the user can see what they're doing.
 */
export async function executeTeamView(
  deps: ToolDeps,
  args: { member: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")

  const member = deps.db.query("SELECT session_id, status, agent FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string; agent: string } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  await deps.client.tui.selectSession({ sessionID: member.session_id })

  return `Switched view to ${args.member}'s session (${member.session_id}). Use the session picker to return to the lead session.`
}
