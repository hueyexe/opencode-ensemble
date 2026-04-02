import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty } from "./shared"
import type { IsDirtyFn } from "./shared"
import { log } from "../log"

/**
 * Execute the team_cleanup tool. Archives the team and cleans up resources.
 * Checks for uncommitted changes BEFORE aborting sessions or removing worktrees.
 * If force=true, aborts active sessions but still blocks on dirty worktrees.
 * Pass acknowledge_uncommitted=true to remove dirty worktrees.
 */
export async function executeTeamCleanup(
  deps: ToolDeps,
  args: { force: boolean; acknowledge_uncommitted?: boolean },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const members = deps.db.query("SELECT name, session_id, status, worktree_dir, worktree_branch, workspace_id FROM team_member WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ name: string; session_id: string; status: string; worktree_dir: string | null; worktree_branch: string | null; workspace_id: string | null }>

  const active = members.filter(m => m.status !== "shutdown" && m.status !== "shutdown_requested" && m.status !== "error")

  if (active.length > 0 && !args.force) {
    const names = active.map(m => m.name).join(", ")
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`)
  }

  // Check for uncommitted changes BEFORE aborting sessions — agents can still commit if warned
  if (!args.acknowledge_uncommitted) {
    const dirty: Array<{ name: string; branch: string }> = []
    for (const member of members) {
      if (member.worktree_dir) {
        try {
          if (await isDirty(member.worktree_dir)) {
            dirty.push({ name: member.name, branch: member.worktree_branch ?? "unknown" })
          }
        } catch {
          log(`cleanup:dirty-check:failed name=${member.name}`)
        }
      }
    }

    if (dirty.length > 0) {
      const warnings = dirty.map(d => `  - ${d.name} (branch: ${d.branch})`).join("\n")
      return `Warning: ${dirty.length} teammate(s) have uncommitted changes in their worktrees:\n${warnings}\n\nCommit or merge their work first, then call team_cleanup with acknowledge_uncommitted: true to proceed.`
    }
  }

  // Force-abort active members (only reached if worktrees are clean or acknowledged)
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
