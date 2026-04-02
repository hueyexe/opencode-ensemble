import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_cleanup tool. Archives the team and cleans up resources.
 * Removes worktrees and lists branches for the lead to merge.
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

  const members = deps.db.query("SELECT name, session_id, status, worktree_dir, worktree_branch, workspace_id FROM team_member WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ name: string; session_id: string; status: string; worktree_dir: string | null; worktree_branch: string | null; workspace_id: string | null }>

  const active = members.filter(m => m.status !== "shutdown" && m.status !== "shutdown_requested" && m.status !== "error")

  if (active.length > 0 && !args.force) {
    const names = active.map(m => m.name).join(", ")
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`)
  }

  // Force-abort active members
  if (args.force) {
    for (const member of active) {
      try {
        await deps.client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }
    }
  }

  // Remove workspaces, worktrees, and collect branches for merging
  const branches: string[] = []
  for (const member of members) {
    if (member.workspace_id) {
      try {
        await deps.client.workspace.remove({ id: member.workspace_id })
        deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort — workspace may already be gone */ }
    }
    if (member.worktree_dir) {
      try {
        await deps.client.worktree.remove({ worktreeRemoveInput: { directory: member.worktree_dir } })
        deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort — worktree may already be gone */ }
    }
    if (member.worktree_branch) {
      branches.push(member.worktree_branch)
    }
  }

  // Archive team
  deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), teamInfo.teamId])

  // Clean up registry
  deps.registry.unregisterTeam(teamInfo.teamId)

  if (branches.length > 0) {
    const mergeCommands = branches.map(b => `  git merge ${b}`).join("\n")
    return `Team "${teamInfo.teamName}" cleaned up. Worktrees removed.\n\nMerge teammate branches:\n${mergeCommands}`
  }

  return `Team "${teamInfo.teamName}" cleaned up.`
}
