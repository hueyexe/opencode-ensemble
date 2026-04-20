import type { ToolDeps } from "../types"
import { requireLead } from "./shared"
import { mergeBranch, deleteBranch, getOverlappingFiles } from "./merge-helper"
import type { MergeBranchFn, DeleteBranchFn, OverlapCheckFn } from "./merge-helper"
import { log } from "../log"

/**
 * Execute the team_merge tool. Merges a shutdown teammate's preserved
 * branch into the working directory as unstaged changes.
 */
export async function executeTeamMerge(
  deps: ToolDeps,
  args: { member: string },
  sessionId: string,
  merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  overlapCheck: OverlapCheckFn = getOverlappingFiles,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query("SELECT status, worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { status: string; worktree_branch: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  if (member.status !== "shutdown" && member.status !== "error") {
    throw new Error(`Teammate "${args.member}" is still active (status: ${member.status}). Shut them down first with team_shutdown.`)
  }

  if (!member.worktree_branch) {
    throw new Error(`No branch to merge for "${args.member}". They may not have a worktree, or their work was already merged.`)
  }

  const branch = member.worktree_branch
  log(`merge:start member=${args.member} branch=${branch}`)

  // Block merge if lead has local changes to files the agent also modified
  try {
    const overlap = await overlapCheck(branch, deps.directory)
    if (overlap.length > 0) {
      const files = overlap.map(f => `  - ${f}`).join("\n")
      return [
        `Cannot merge ${args.member} — you have local changes to the same files:`,
        files,
        ``,
        `Commit or stash your changes first, then retry team_merge.`,
        `Branch preserved: ${branch}`,
      ].join("\n")
    }
  } catch {
    log(`merge:overlap-check:failed member=${args.member} branch=${branch}`)
  }

  const result = await merge(branch, deps.directory)
  if (!result.ok) {
    return [
      `Merge conflict merging ${args.member}'s branch (${branch}).`,
      `Resolve manually:`,
      `  git merge --squash ${branch}`,
      `  git reset HEAD`,
      ``,
      `Error: ${result.error}`,
    ].join("\n")
  }

  // Merge succeeded — delete the preserved branch and clear DB
  await delBranch(branch, deps.directory)
  deps.db.run(
    "UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?",
    [teamInfo.teamId, args.member],
  )

  log(`merge:done member=${args.member} branch=${branch}`)
  return `Merged ${args.member}'s changes into your working directory (unstaged). Review with: git diff`
}
