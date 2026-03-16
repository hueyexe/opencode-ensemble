import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_cleanup tool. Archives the team and cleans up resources.
 * If force=true, aborts all active member sessions first.
 */
export async function executeTeamCleanup(
  deps: ToolDeps,
  args: { force: boolean },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can clean up the team.")

  const members = deps.db.query("SELECT name, session_id, status FROM team_member WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ name: string; session_id: string; status: string }>

  const active = members.filter(m => m.status !== "shutdown")

  if (active.length > 0 && !args.force) {
    const names = active.map(m => m.name).join(", ")
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`)
  }

  // Force-abort active members
  if (args.force) {
    for (const member of active) {
      try {
        await deps.client.session.abort({ path: { id: member.session_id } })
      } catch {
        // Best effort
      }
    }
  }

  // Archive team
  deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), teamInfo.teamId])

  // Clean up registry
  deps.registry.unregisterTeam(teamInfo.teamId)

  return `Team "${teamInfo.teamName}" cleaned up.`
}
