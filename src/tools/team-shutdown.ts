import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty } from "./shared"
import type { IsDirtyFn } from "./shared"
import { preserveBranch, preservedBranchName } from "./merge-helper"
import type { PreserveBranchFn } from "./merge-helper"
import { log } from "../log"

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 *
 * Before aborting, preserves the worktree branch to a safe ref so
 * session.abort() cannot destroy the agent's committed work.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: { member: string; force?: boolean },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  preserve: PreserveBranchFn = preserveBranch,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query("SELECT session_id, status, worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string; worktree_branch: string | null; worktree_dir: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") throw new Error(`Teammate "${args.member}" is already shut down`)

  const force = args.force ?? false

  // Second call on an already-requested member → force abort
  if (member.status === "shutdown_requested") {
    await preserveAndAbort(deps, teamInfo.teamId, teamInfo.teamName, args.member, member.session_id, member.worktree_branch, preserve)
    const branchInfo = getBranchInfo(deps, teamInfo.teamId, args.member)
    const dirtyWarning = await getDirtyWarning(member.worktree_dir, args.member, isDirty)
    return `Force shut down "${args.member}".${branchInfo}${dirtyWarning}`
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
    await preserveAndAbort(deps, teamInfo.teamId, teamInfo.teamName, args.member, member.session_id, member.worktree_branch, preserve)
    const branchInfo = getBranchInfo(deps, teamInfo.teamId, args.member)
    const dirtyWarning = await getDirtyWarning(member.worktree_dir, args.member, isDirty)
    return `Teammate "${args.member}" has been shut down.${branchInfo}${dirtyWarning}`
  }

  // Busy + not force → graceful: preserve branch first, then send shutdown message
  // Branch must be preserved NOW — if the session crashes during shutdown_requested,
  // the worktree and branch could be lost before force-abort ever runs.
  if (member.worktree_branch) {
    const safeBranch = preservedBranchName(teamInfo.teamName, args.member)
    const ok = await preserve(member.worktree_branch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamInfo.teamId, args.member],
      )
      log(`shutdown:branch:preserved-graceful src=${member.worktree_branch} target=${safeBranch}`)
    }
  }

  try {
    deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{
        type: "text",
        text: `[Shutdown requested]: The lead has requested you shut down. Finish your current task, send your final findings to the lead via team_message, then stop.`,
      }],
    }).catch(() => { /* fire-and-forget */ })
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
 * Preserve the worktree branch, then abort the session and mark shutdown.
 * The branch is copied to ensemble/preserved/{team}/{name} BEFORE abort,
 * so session.abort() cannot destroy the agent's committed work.
 */
async function preserveAndAbort(
  deps: ToolDeps,
  teamId: string,
  teamName: string,
  memberName: string,
  sessionId: string,
  worktreeBranch: string | null,
  preserve: PreserveBranchFn,
): Promise<void> {
  // Preserve the branch BEFORE aborting — session.abort() may delete the worktree + branch
  if (worktreeBranch && !worktreeBranch.startsWith("ensemble/preserved/")) {
    const safeBranch = preservedBranchName(teamName, memberName)
    const ok = await preserve(worktreeBranch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamId, memberName],
      )
      log(`shutdown:branch:preserved src=${worktreeBranch} target=${safeBranch}`)
    } else {
      log(`shutdown:branch:preserve-failed src=${worktreeBranch} target=${safeBranch}`)
    }
  }

  // Now safe to abort — the branch is preserved
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

/** Read the current branch from DB (may have been updated to preserved name). */
function getBranchInfo(deps: ToolDeps, teamId: string, memberName: string): string {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { worktree_branch: string | null } | null
  return row?.worktree_branch ? ` Changes preserved on branch: ${row.worktree_branch}. Use team_merge to merge.` : ""
}

/** Build a warning suffix if the member's worktree has uncommitted changes. */
async function getDirtyWarning(worktreeDir: string | null, memberName: string, isDirty: IsDirtyFn): Promise<string> {
  if (!worktreeDir) return ""
  try {
    if (await isDirty(worktreeDir)) {
      return `\n\nWarning: ${memberName} has uncommitted changes in their worktree. Commit or merge before calling team_cleanup.`
    }
  } catch { /* best effort */ }
  return ""
}
