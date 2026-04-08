import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty } from "./shared"
import type { IsDirtyFn } from "./shared"
import { spawnFailures } from "./team-spawn"
import { mergeBranch, deleteBranch, preserveBranch, preservedBranchName } from "./merge-helper"
import type { MergeBranchFn, DeleteBranchFn, PreserveBranchFn } from "./merge-helper"
import { log } from "../log"

/**
 * Execute the team_cleanup tool. Archives the team and cleans up resources.
 * Acts as a safety net: merges any remaining unmerged preserved branches
 * that the lead forgot to merge with team_merge.
 */
export async function executeTeamCleanup(
  deps: ToolDeps,
  args: { force: boolean; acknowledge_uncommitted?: boolean },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  mergeOnCleanup = true,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const members = deps.db.query("SELECT name, session_id, status, worktree_dir, worktree_branch, workspace_id FROM team_member WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ name: string; session_id: string; status: string; worktree_dir: string | null; worktree_branch: string | null; workspace_id: string | null }>

  const active = members.filter(m => m.status !== "shutdown" && m.status !== "shutdown_requested" && m.status !== "error")

  if (active.length > 0 && !args.force) {
    const names = active.map(m => m.name).join(", ")
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`)
  }

  // Check for uncommitted changes BEFORE aborting sessions
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

  // Force-abort active members — preserve branches BEFORE aborting
  if (args.force) {
    for (const member of active) {
      // Preserve branch before abort — session.abort() may destroy the worktree + branch
      if (member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(teamInfo.teamName, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, deps.directory)
        if (ok) {
          deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, teamInfo.teamId, member.name])
          member.worktree_branch = safeBranch
        }
      }
      try {
        await deps.client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }
    }
  }

  // Safety net: merge any remaining unmerged preserved branches
  const unmerged = members.filter(m => m.worktree_branch !== null)
  const merged: string[] = []
  const conflicted: string[] = []

  if (unmerged.length > 0 && mergeOnCleanup) {
    for (const member of unmerged) {
      const branch = member.worktree_branch!
      const result = await merge(branch, deps.directory)
      if (result.ok) {
        await delBranch(branch, deps.directory)
        deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
        merged.push(`${member.name} (${branch})`)
      } else {
        log(`cleanup:merge:conflict member=${member.name} branch=${branch} err=${result.error}`)
        conflicted.push(`${member.name} (${branch})`)
      }
    }
  }

  // Remove workspaces and worktrees
  for (const member of members) {
    if (member.workspace_id) {
      try {
        await deps.client.workspace.remove({ id: member.workspace_id })
        deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort */ }
    }
    if (member.worktree_dir) {
      try {
        await deps.client.worktree.remove({ worktreeRemoveInput: { directory: member.worktree_dir } })
        deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort */ }
    }
  }

  // Archive team
  deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), teamInfo.teamId])

  // Clean up in-memory state
  deps.registry.unregisterTeam(teamInfo.teamId)
  spawnFailures.delete(teamInfo.teamId)

  // Build response
  const parts: string[] = [`Team "${teamInfo.teamName}" cleaned up.`]
  if (merged.length > 0) {
    parts.push(`Safety-net merged ${merged.length} unmerged branch(es): ${merged.join(", ")}. Review with: git diff`)
  }
  if (conflicted.length > 0) {
    parts.push(`Could not auto-merge: ${conflicted.join(", ")}. Merge manually.`)
  }
  return parts.join("\n")
}
