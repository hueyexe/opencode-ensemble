import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import { executeTeamMerge } from "../src/tools/team-merge"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamCreate } from "../src/tools/team-create"
import { getTeamResourceParts, preservedBranchName } from "../src/tools/merge-helper"
import type { MergeBranchFn, DeleteBranchFn, PreserveBranchFn, OverlapCheckFn } from "../src/tools/merge-helper"
import { spawnFailures } from "../src/tools/team-spawn"

type Deps = ReturnType<typeof setupDeps>

const noopPreserve: PreserveBranchFn = async () => true
const noopMerge: MergeBranchFn = async () => ({ ok: true })
const noopDelete: DeleteBranchFn = async () => true
const noopOverlap: OverlapCheckFn = async () => []
const failMerge: MergeBranchFn = async () => ({ ok: false, error: "CONFLICT in file.ts" })

function teamId(deps: Deps, name: string): string {
  return (deps.db.query("SELECT id FROM team WHERE name = ?").get(name) as { id: string }).id
}

function preservedFor(deps: Deps, teamName: string, memberName: string): string {
  const resource = getTeamResourceParts(deps.db, teamId(deps, teamName))
  return preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
}

// ─── Branch preservation on shutdown ───

describe("branch preservation", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("shutdown preserves worktree branch before aborting session", async () => {
    await executeTeamCreate(deps, { name: "preserve-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)

    // Verify alice has a worktree branch
    const before = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(before.worktree_branch).toBeTruthy()
    const originalBranch = before.worktree_branch!

    // Track what preserve was called with
    let preserveCalled = false
    let preserveSource = ""
    let preserveTarget = ""
    const trackPreserve: PreserveBranchFn = async (src, target) => {
      preserveCalled = true
      preserveSource = src
      preserveTarget = target
      return true
    }

    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, trackPreserve)

    // Preserve was called with the original branch
    expect(preserveCalled).toBe(true)
    expect(preserveSource).toBe(originalBranch)
    const preserved = preservedFor(deps, "preserve-test", "alice")
    expect(preserveTarget).toBe(preserved)

    // DB was updated to the preserved branch name
    const after = deps.db.query("SELECT worktree_branch, status FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null; status: string }
    expect(after.worktree_branch).toBe(preserved)
    expect(after.status).toBe("shutdown")
  })

  test("shutdown still completes if preserve fails", async () => {
    await executeTeamCreate(deps, { name: "fail-preserve" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task" }, lead)

    const failPreserve: PreserveBranchFn = async () => false

    // Should not throw — preserve failure is logged but shutdown continues
    const result = await executeTeamShutdown(deps, { member: "bob" }, lead, undefined, failPreserve)
    expect(result).toContain("shut down")

    // Member is shutdown but branch was NOT updated (preserve failed)
    const after = deps.db.query("SELECT status FROM team_member WHERE name = 'bob'")
      .get() as { status: string }
    expect(after.status).toBe("shutdown")
  })

  test("shutdown without worktree branch skips preservation", async () => {
    await executeTeamCreate(deps, { name: "no-wt" }, lead)
    await executeTeamSpawn(deps, { name: "carol", agent: "explore", prompt: "task", worktree: false }, lead)

    let preserveCalled = false
    const trackPreserve: PreserveBranchFn = async () => {
      preserveCalled = true
      return true
    }

    await executeTeamShutdown(deps, { member: "carol" }, lead, undefined, trackPreserve)

    // Preserve was NOT called — no branch to preserve
    expect(preserveCalled).toBe(false)
  })

  test("preserve happens BEFORE session.abort", async () => {
    await executeTeamCreate(deps, { name: "order-test" }, lead)
    await executeTeamSpawn(deps, { name: "dave", agent: "build", prompt: "task" }, lead)

    const callOrder: string[] = []
    const trackPreserve: PreserveBranchFn = async () => {
      callOrder.push("preserve")
      return true
    }

    // Override session.abort to track call order
    const origAbort = deps.client.session.abort
    deps.client.session.abort = async (args) => {
      callOrder.push("abort")
      return origAbort(args)
    }

    await executeTeamShutdown(deps, { member: "dave" }, lead, undefined, trackPreserve)

    // Preserve MUST happen before abort
    expect(callOrder).toEqual(["preserve", "abort"])
  })

  test("force shutdown also preserves branch", async () => {
    await executeTeamCreate(deps, { name: "force-test" }, lead)
    await executeTeamSpawn(deps, { name: "eve", agent: "build", prompt: "task" }, lead)

    let preserveCalled = false
    const trackPreserve: PreserveBranchFn = async () => {
      preserveCalled = true
      return true
    }

    await executeTeamShutdown(deps, { member: "eve", force: true }, lead, undefined, trackPreserve)
    expect(preserveCalled).toBe(true)
  })

  test("preservedBranchName generates correct format", () => {
    expect(preservedBranchName("silver-river", "my-team", "team_abc123", "alice")).toBe("ensemble/preserved/silver-river/my-team#abc123/alice")
    expect(preservedBranchName("copper-orbit", "refactor", "t1", "bob")).toBe("ensemble/preserved/copper-orbit/refactor#t1/bob")
  })
})

// ─── team_merge tool ───

describe("team_merge", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("merges a shutdown member's preserved branch", async () => {
    await executeTeamCreate(deps, { name: "merge-team" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    expect(result).toContain("Merged alice's changes")
    expect(result).toContain("unstaged")
    expect(result).toContain("git diff")
  })

  test("clears worktree_branch in DB after successful merge", async () => {
    await executeTeamCreate(deps, { name: "clear-branch" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)

    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).toBeNull()
  })

  test("deletes the preserved branch after merge", async () => {
    await executeTeamCreate(deps, { name: "del-branch" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let deletedBranch = ""
    const trackDelete: DeleteBranchFn = async (branch) => {
      deletedBranch = branch
      return true
    }

    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, trackDelete, noopOverlap)
    expect(deletedBranch).toBe(preservedFor(deps, "del-branch", "alice"))
  })

  test("rejects merge for active (non-shutdown) member", async () => {
    await executeTeamCreate(deps, { name: "active-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)

    await expect(executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap))
      .rejects.toThrow("still active")
  })

  test("rejects merge for member with no branch", async () => {
    await executeTeamCreate(deps, { name: "no-branch" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "explore", prompt: "task", worktree: false }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    await expect(executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap))
      .rejects.toThrow("No branch to merge")
  })

  test("rejects merge for already-merged member", async () => {
    await executeTeamCreate(deps, { name: "double-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    // First merge succeeds
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)

    // Second merge fails — branch already cleared
    await expect(executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap))
      .rejects.toThrow("No branch to merge")
  })

  test("returns conflict message on merge failure", async () => {
    await executeTeamCreate(deps, { name: "conflict-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, failMerge, noopDelete, noopOverlap)
    expect(result).toContain("Merge conflict")
    expect(result).toContain("CONFLICT")

    // Branch is NOT cleared on conflict — user can retry
    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).not.toBeNull()
  })

  test("rejects merge from non-lead", async () => {
    await executeTeamCreate(deps, { name: "non-lead" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)

    const aliceSess = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'alice'")
      .get() as { session_id: string }).session_id

    await expect(executeTeamMerge(deps, { member: "alice" }, aliceSess, noopMerge, noopDelete, noopOverlap))
      .rejects.toThrow()
  })

  test("blocks merge when lead has overlapping local changes", async () => {
    await executeTeamCreate(deps, { name: "overlap-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const overlapFiles: OverlapCheckFn = async () => ["config.py", "conftest.py"]
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, trackMerge, noopDelete, overlapFiles)
    expect(result).toContain("config.py")
    expect(result).toContain("conftest.py")
    expect(result).toContain("local changes")
    expect(mergeCalled).toBe(false)

    // Branch is preserved for retry — NOT cleared
    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).not.toBeNull()
  })

  test("proceeds with merge when no overlapping files", async () => {
    await executeTeamCreate(deps, { name: "no-overlap" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, trackMerge, noopDelete, noopOverlap)
    expect(mergeCalled).toBe(true)
    expect(result).toContain("Merged alice's changes")
  })

  test("merge output is clear and actionable", async () => {
    await executeTeamCreate(deps, { name: "msg-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    expect(result).toContain("Merged alice's changes into your working directory (unstaged)")
    expect(result).toContain("git diff")
  })

  test("proceeds with merge when overlap check fails", async () => {
    await executeTeamCreate(deps, { name: "overlap-err" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const failingOverlap: OverlapCheckFn = async () => { throw new Error("git diff failed") }
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, trackMerge, noopDelete, failingOverlap)
    expect(mergeCalled).toBe(true)
    expect(result).toContain("Merged alice's changes")
  })
})

// ─── Regression: honest reporting when there's nothing to merge ───
//
// Bug found via live N=4 concurrency testing (2026-08-17): a teammate that writes a file
// but never commits leaves its branch with zero new commits. `git merge --squash` against
// a branch with nothing new is a legitimate no-op that reports success -- team_merge then
// unconditionally returned "Merged alice's changes... unstaged", which is TRUE in a narrow
// technical sense but actively misleading: nothing was actually captured. The uncommitted
// work exists only in the now-abandoned worktree and is permanently lost the moment
// team_cleanup removes it. team_shutdown and team_cleanup both already warn about this
// (uncommitted-changes detection existed before this fix) -- the gap was specifically
// team_merge's own success message papering over a no-op.
describe("team_merge — honest reporting when nothing to merge", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("reports uncommitted-work-at-risk instead of false success when branch has zero commits and worktree is dirty", async () => {
    await executeTeamCreate(deps, { name: "no-commit-dirty" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    let deleteCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }
    const trackDelete: DeleteBranchFn = async () => { deleteCalled = true; return true }

    const result = await executeTeamMerge(
      deps, { member: "alice" }, lead,
      trackMerge, trackDelete, noopOverlap,
      async () => 0,    // commitCount: zero commits on the branch
      async () => true, // isDirty: worktree has uncommitted changes
    )

    expect(result).toContain("Nothing to merge")
    expect(result).toContain("uncommitted")
    expect(result).not.toContain("Merged alice's changes")
    // Must not proceed as if the merge succeeded -- no false "merged" claim, and the
    // branch/worktree must not be torn down while it's the only copy of the work.
    expect(mergeCalled).toBe(false)
    expect(deleteCalled).toBe(false)

    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).not.toBeNull()
  })

  test("reports plainly that the member made no changes when branch has zero commits and worktree is clean", async () => {
    await executeTeamCreate(deps, { name: "no-commit-clean" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(
      deps, { member: "alice" }, lead,
      noopMerge, noopDelete, noopOverlap,
      async () => 0,     // commitCount: zero commits
      async () => false, // isDirty: nothing uncommitted either
    )

    expect(result).toContain("Nothing to merge")
    expect(result).toContain("no changes")
    expect(result).not.toContain("Merged alice's changes")
  })

  test("still merges normally when the branch has real commits", async () => {
    await executeTeamCreate(deps, { name: "has-commits" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(
      deps, { member: "alice" }, lead,
      trackMerge, noopDelete, noopOverlap,
      async () => 1,     // commitCount: one real commit
      async () => false,
    )

    expect(mergeCalled).toBe(true)
    expect(result).toContain("Merged alice's changes")
  })

  test("falls through to the normal merge path when commit count cannot be determined", async () => {
    await executeTeamCreate(deps, { name: "commit-count-unknown" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    // countBranchCommits returns -1 on failure (git error) -- must not be treated as "zero
    // commits, nothing to merge". An unknown count should never silently skip a real merge.
    const result = await executeTeamMerge(
      deps, { member: "alice" }, lead,
      trackMerge, noopDelete, noopOverlap,
      async () => -1,
      async () => false,
    )

    expect(mergeCalled).toBe(true)
    expect(result).toContain("Merged alice's changes")
  })
})

// ─── Cleanup safety net ───

describe("cleanup safety net for unmerged branches", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("cleanup merges remaining unmerged branches as safety net", async () => {
    await executeTeamCreate(deps, { name: "safety-net" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    // Lead forgot to call team_merge — cleanup should catch it
    const mergedBranches: string[] = []
    const trackMerge: MergeBranchFn = async (branch) => {
      mergedBranches.push(branch)
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("Safety-net merged")
    expect(mergedBranches).toHaveLength(1)
    expect(mergedBranches[0]).toBe(preservedFor(deps, "safety-net", "alice"))
  })

  test("cleanup skips already-merged members", async () => {
    await executeTeamCreate(deps, { name: "already-merged" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    // Lead merges explicitly
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)

    // Cleanup should have nothing to merge
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => {
      mergeCalled = true
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("cleaned up")
    expect(result).not.toContain("Safety-net")
    expect(mergeCalled).toBe(false)
  })

  test("cleanup reports conflicts from safety-net merge", async () => {
    await executeTeamCreate(deps, { name: "conflict-safety" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, failMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("Could not auto-merge")
  })

  test("cleanup with mergeOnCleanup=false skips safety-net merge", async () => {
    await executeTeamCreate(deps, { name: "no-safety" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => {
      mergeCalled = true
      return { ok: true }
    }

    await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, false, noopOverlap)
    expect(mergeCalled).toBe(false)
  })

  test("cleanup handles mix of merged and unmerged members", async () => {
    await executeTeamCreate(deps, { name: "mixed-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamShutdown(deps, { member: "bob" }, lead, undefined, noopPreserve)

    // Merge alice explicitly, leave bob for safety net
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)

    const mergedBranches: string[] = []
    const trackMerge: MergeBranchFn = async (branch) => {
      mergedBranches.push(branch)
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("Safety-net merged 1 unmerged branch")
    expect(mergedBranches).toHaveLength(1)
    expect(mergedBranches[0]).toBe(preservedFor(deps, "mixed-merge", "bob"))
  })

  test("cleanup safety-net reports overlap warnings", async () => {
    await executeTeamCreate(deps, { name: "overlap-cleanup" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const overlapFiles: OverlapCheckFn = async () => ["config.py", "conftest.py"]

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, noopMerge, noopDelete, true, overlapFiles)
    expect(result).toContain("config.py")
    expect(result).toContain("overlap")
  })
})

// ─── Full lifecycle: spawn → shutdown → merge → cleanup ───

describe("full merge lifecycle", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("spawn → shutdown (preserves) → merge → cleanup (nothing left)", async () => {
    // 1. Create team and spawn
    await executeTeamCreate(deps, { name: "lifecycle" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "implement auth" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "write tests" }, lead)

    // 2. Shutdown both — branches preserved
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamShutdown(deps, { member: "bob" }, lead, undefined, noopPreserve)

    // Verify branches are preserved
    const aliceBranch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string }).worktree_branch
    const bobBranch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'bob'")
      .get() as { worktree_branch: string }).worktree_branch
    expect(aliceBranch).toBe(preservedFor(deps, "lifecycle", "alice"))
    expect(bobBranch).toBe(preservedFor(deps, "lifecycle", "bob"))

    // 3. Merge both explicitly
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    await executeTeamMerge(deps, { member: "bob" }, lead, noopMerge, noopDelete, noopOverlap)

    // Verify branches are cleared
    const aliceAfter = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }).worktree_branch
    const bobAfter = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'bob'")
      .get() as { worktree_branch: string | null }).worktree_branch
    expect(aliceAfter).toBeNull()
    expect(bobAfter).toBeNull()

    // 4. Cleanup — nothing to merge
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => {
      mergeCalled = true
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("cleaned up")
    expect(result).not.toContain("Safety-net")
    expect(mergeCalled).toBe(false)

    // Team is archived
    const team = deps.db.query("SELECT status FROM team WHERE name = 'lifecycle'")
      .get() as { status: string }
    expect(team.status).toBe("archived")
  })
})
