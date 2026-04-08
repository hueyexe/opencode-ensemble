import { log } from "../log"

/** Result of merging a single branch. */
export interface MergeResult {
  ok: boolean
  error?: string
}

/** Injectable function for testing. */
export type MergeBranchFn = (branch: string, cwd: string) => Promise<MergeResult>

/** Injectable function for preserving a branch before worktree deletion. */
export type PreserveBranchFn = (sourceBranch: string, targetBranch: string, cwd: string) => Promise<boolean>

/** Injectable function for deleting a branch. */
export type DeleteBranchFn = (branch: string, cwd: string) => Promise<boolean>

/**
 * Copy a git branch to a new ref. Used to preserve worktree branches
 * before session.abort() which may delete the worktree and its branch.
 * Returns true if the branch was successfully copied.
 */
export async function preserveBranch(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "branch", targetBranch, sourceBranch], { cwd, stdout: "pipe", stderr: "pipe" })
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    log(`merge-helper:preserve:failed src=${sourceBranch} target=${targetBranch} err=${stderr.trim()}`)
    return false
  }
  return true
}

/**
 * Delete a git branch. Returns true if successful.
 */
export async function deleteBranch(branch: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "branch", "-D", branch], { cwd, stdout: "pipe", stderr: "pipe" })
  const exit = await proc.exited
  if (exit !== 0) {
    log(`merge-helper:delete:failed branch=${branch}`)
    return false
  }
  return true
}

/**
 * Raw squash merge of a single branch. No stash/pop — caller handles that.
 * Used by mergeBranch (single) and mergeMultipleBranches (batch).
 */
export async function mergeBranchRaw(branch: string, cwd: string): Promise<MergeResult> {
  const merge = Bun.spawn(["git", "merge", "--squash", branch], { cwd, stdout: "pipe", stderr: "pipe" })
  const stderrPromise = new Response(merge.stderr).text()
  const mergeExit = await merge.exited

  if (mergeExit !== 0) {
    const stderr = await stderrPromise
    log(`merge-helper:merge:conflict branch=${branch} err=${stderr.trim()}`)
    const abort = Bun.spawn(["git", "merge", "--abort"], { cwd, stdout: "pipe", stderr: "pipe" })
    await abort.exited
    return { ok: false, error: stderr.trim() || `merge exited with code ${mergeExit}` }
  }

  return { ok: true }
}

/** Stash existing work. Returns true if something was stashed. */
export async function gitStash(cwd: string): Promise<boolean> {
  const stash = Bun.spawn(["git", "stash", "--include-untracked"], { cwd, stdout: "pipe", stderr: "pipe" })
  const stashOut = await new Response(stash.stdout).text()
  const stashExit = await stash.exited
  return stashExit === 0 && !stashOut.includes("No local changes")
}

/** Unstage all changes. */
export async function gitReset(cwd: string): Promise<void> {
  const reset = Bun.spawn(["git", "reset", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" })
  await reset.exited
}

/** Restore stashed work, preserving staged/unstaged state. Returns true if successful. */
export async function gitStashPop(cwd: string): Promise<boolean> {
  const pop = Bun.spawn(["git", "stash", "pop", "--index"], { cwd, stdout: "pipe", stderr: "pipe" })
  const exit = await pop.exited
  if (exit !== 0) {
    // --index is strict about staged/unstaged distinction — fall back to plain pop
    const fallback = Bun.spawn(["git", "stash", "pop"], { cwd, stdout: "pipe", stderr: "pipe" })
    const fallbackExit = await fallback.exited
    if (fallbackExit !== 0) {
      log("merge-helper:stash-pop:failed — stashed work remains in git stash list")
      return false
    }
  }
  return true
}

/**
 * Stash-safe squash merge of a single branch into the working directory.
 * Stashes existing work, merges, unstages, restores stash.
 */
export async function mergeBranch(branch: string, cwd: string): Promise<MergeResult> {
  const didStash = await gitStash(cwd)

  const result = await mergeBranchRaw(branch, cwd)
  if (!result.ok) {
    if (didStash) {
      const restored = await gitStashPop(cwd)
      if (!restored) return { ok: false, error: `${result.error}. WARNING: stashed work could not be restored — check git stash list` }
    }
    return result
  }

  await gitReset(cwd)
  if (didStash) {
    const restored = await gitStashPop(cwd)
    if (!restored) return { ok: true, error: "Merge succeeded but stashed work could not be restored — check git stash list" }
  }
  return { ok: true }
}

/**
 * Build the preserved branch name for a team member.
 */
export function preservedBranchName(teamName: string, memberName: string): string {
  return `ensemble/preserved/${teamName}/${memberName}`
}
