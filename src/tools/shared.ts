import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/** Function type for dirty worktree check — injectable for testing. */
export type IsDirtyFn = (dir: string) => Promise<boolean>

/** Function type for counting commits on a branch — injectable for testing. */
export type CommitCountFn = (branch: string, cwd: string) => Promise<number>

/** Count commits a branch has ahead of HEAD. Approximate — may include base divergence. Returns -1 if check fails. */
export async function countBranchCommits(branch: string, cwd: string): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "rev-list", "--count", `HEAD..${branch}`], { cwd, stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const exit = await proc.exited
    if (exit !== 0) return -1
    const n = Number.parseInt(out.trim(), 10)
    return Number.isNaN(n) ? -1 : n
  } catch { return -1 }
}

/** Check if a worktree directory has uncommitted changes via git status. */
export async function checkWorktreeDirty(dir: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, "status", "--porcelain"], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) return false // git failed — assume clean
    return output.trim().length > 0
  } catch {
    return false // can't check — assume clean
  }
}

/** Validate that the session belongs to the team lead. Throws if not. */
export function requireLead(
  deps: Pick<ToolDeps, "db" | "registry">,
  sessionId: string,
): { teamId: string; teamName: string } {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can use this tool.")
  return { teamId: teamInfo.teamId, teamName: teamInfo.teamName }
}

/** Validate that the session belongs to any team member (lead or teammate). Throws if not. */
export function requireTeamMember(
  deps: Pick<ToolDeps, "db" | "registry">,
  sessionId: string,
): { teamId: string; teamName: string; role: "lead" | "member"; memberName?: string } {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")
  return teamInfo
}
