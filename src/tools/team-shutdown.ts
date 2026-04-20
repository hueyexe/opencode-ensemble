import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty, countBranchCommits } from "./shared"
import type { IsDirtyFn, CommitCountFn } from "./shared"
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
  commitCount: CommitCountFn = countBranchCommits,
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
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Force shut down "${args.member}".${status}`
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
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Teammate "${args.member}" has been shut down.${status}`
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

/** Build a status line describing the teammate's work: commit count, dirty state, next step. */
async function getBranchStatus(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  worktreeDir: string | null,
  isDirty: IsDirtyFn,
  commitCount: CommitCountFn,
): Promise<string> {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { worktree_branch: string | null } | null
  if (!row?.worktree_branch) return ""

  const branch = row.worktree_branch
  const parts: string[] = []

  const commits = await commitCount(branch, deps.directory)
  // Best-effort dirty check — worktree may already be deleted by session.abort() race
  const dirty = worktreeDir ? await isDirty(worktreeDir).catch(() => false) : false

  if (commits > 0 && dirty) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""} and has uncommitted work.`)
  } else if (commits > 0) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""}. Ready to merge.`)
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes only — their work may be incomplete.`)
  } else if (commits < 0) {
    parts.push(`Could not determine ${memberName}'s commit status. Merge to check their work.`)
  } else {
    parts.push(`${memberName} made no changes.`)
  }

  parts.push(`Branch: ${branch}`)
  parts.push("Use team_merge to merge their work.")
  return `\n${parts.join("\n")}`
}
