import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { requireLead, requireTeamMember, gitRevParse, gitBranch, gitWorktreeAdd, gitWorktreeRemove } from "../../src/tools/shared"
import { execSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("requireLead", () => {
  let deps: ReturnType<typeof setupDeps>
  beforeEach(() => { deps = setupDeps(); insertTeam(deps.db, "t1", "my-team", "lead-sess") })

  test("returns team info for the lead session", () => {
    const result = requireLead(deps, "lead-sess")
    expect(result.teamId).toBe("t1")
    expect(result.teamName).toBe("my-team")
  })
  test("throws if session is not in a team", () => {
    expect(() => requireLead(deps, "random-sess")).toThrow("not in a team")
  })
  test("throws if session is a member, not the lead", () => {
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
    expect(() => requireLead(deps, "sess-alice")).toThrow("Only the team lead")
  })
})

describe("requireTeamMember", () => {
  let deps: ReturnType<typeof setupDeps>
  beforeEach(() => { deps = setupDeps(); insertTeam(deps.db, "t1", "my-team", "lead-sess") })

  test("returns team info for the lead", () => {
    const result = requireTeamMember(deps, "lead-sess")
    expect(result.teamId).toBe("t1")
    expect(result.role).toBe("lead")
  })
  test("returns team info for a member", () => {
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
    const result = requireTeamMember(deps, "sess-alice")
    expect(result.role).toBe("member")
    expect(result.memberName).toBe("alice")
  })
  test("throws if session is not in a team", () => {
    expect(() => requireTeamMember(deps, "random-sess")).toThrow("not in a team")
  })
})

describe("git helpers", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(realpathSync(tmpdir()), "ensemble-git-test-"))
    execSync("git init", { cwd: testDir })
    execSync("git config user.email 'test@test.com'", { cwd: testDir })
    execSync("git config user.name 'Test'", { cwd: testDir })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("gitRevParse returns HEAD sha", async () => {
    execSync("git commit --allow-empty -m 'init'", { cwd: testDir })
    const sha = await gitRevParse(testDir, "HEAD")
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test("gitRevParse throws for invalid ref", async () => {
    await expect(gitRevParse(testDir, "nonexistent")).rejects.toThrow()
  })

  test("gitBranch creates a branch", async () => {
    execSync("git commit --allow-empty -m 'init'", { cwd: testDir })
    const ok = await gitBranch(testDir, "test-branch", "HEAD")
    expect(ok).toBe(true)

    // Verify branch exists
    const branches = execSync("git branch --list test-branch", { cwd: testDir }).toString()
    expect(branches).toContain("test-branch")
  })

  test("gitBranch returns false if branch already exists", async () => {
    execSync("git commit --allow-empty -m 'init'", { cwd: testDir })
    await gitBranch(testDir, "test-branch", "HEAD")
    const ok = await gitBranch(testDir, "test-branch", "HEAD")
    expect(ok).toBe(false)
  })

  test("gitWorktreeAdd creates a worktree", async () => {
    execSync("git commit --allow-empty -m 'init'", { cwd: testDir })
    await gitBranch(testDir, "wt-branch", "HEAD")

    const wtPath = join(testDir, "worktree-dir")
    const ok = await gitWorktreeAdd(testDir, wtPath, "wt-branch")
    expect(ok).toBe(true)

    // Verify worktree exists (normalize path separators for cross-platform)
    const worktrees = execSync("git worktree list", { cwd: testDir }).toString().replace(/\\/g, "/")
    expect(worktrees).toContain(wtPath.replace(/\\/g, "/"))
  })

  test("gitWorktreeAdd returns false for invalid branch", async () => {
    const wtPath = join(testDir, "worktree-dir")
    const ok = await gitWorktreeAdd(testDir, wtPath, "nonexistent-branch")
    expect(ok).toBe(false)
  })

  test("gitWorktreeRemove removes a worktree", async () => {
    execSync("git commit --allow-empty -m 'init'", { cwd: testDir })
    await gitBranch(testDir, "wt-branch", "HEAD")

    const wtPath = join(testDir, "worktree-dir")
    await gitWorktreeAdd(testDir, wtPath, "wt-branch")

    const ok = await gitWorktreeRemove(testDir, wtPath)
    expect(ok).toBe(true)

    // Verify worktree removed
    const worktrees = execSync("git worktree list", { cwd: testDir }).toString()
    expect(worktrees).not.toContain(wtPath)
  })

  test("gitWorktreeRemove returns false for non-existent worktree", async () => {
    const wtPath = join(testDir, "nonexistent-wt")
    const ok = await gitWorktreeRemove(testDir, wtPath)
    expect(ok).toBe(false)
  })
})
