import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamShutdown } from "../../src/tools/team-shutdown"
import { executeTeamCleanup } from "../../src/tools/team-cleanup"

describe("team_shutdown", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("sets member to shutdown_requested and calls abort", async () => {
    // Mock status returns busy — session still running
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    expect(result).toContain("Shutdown requested")
    expect(result).toContain("alice")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
  })

  test("transitions to shutdown when session is already idle after abort", async () => {
    // Mock status to return idle for alice's session
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }

    await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("stays shutdown_requested when session is still busy after abort", async () => {
    // Mock status to return busy for alice's session
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })

  test("rejects if caller is not the lead", async () => {
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "bob", "sess-bob")

    await expect(executeTeamShutdown(deps, { member: "alice" }, "sess-bob"))
      .rejects.toThrow("Only the team lead")
  })

  test("rejects if member not found", async () => {
    await expect(executeTeamShutdown(deps, { member: "unknown" }, "lead-sess"))
      .rejects.toThrow("not found")
  })

  test("rejects if member already shutdown", async () => {
    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE name = 'alice'")
    await expect(executeTeamShutdown(deps, { member: "alice" }, "lead-sess"))
      .rejects.toThrow("already shut down")
  })

  test("handles abort failure gracefully and still completes shutdown", async () => {
    deps.client.session.abort = async () => { throw new Error("session gone") }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    // Session is gone, so status poll finds nothing → transitions to shutdown
    expect(result).toContain("shut down")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("shutdown")

    // Toast warning should have been fired for the abort failure
    const toastCalls = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toastCalls.length).toBeGreaterThanOrEqual(1)
    const msg = (toastCalls[0]!.args[0] as Record<string, unknown>).message as string
    expect(msg).toContain("alice")
  })

  test("handles abort failure and stays shutdown_requested when status poll also fails", async () => {
    deps.client.session.abort = async () => { throw new Error("session gone") }
    deps.client.session.status = async () => { throw new Error("status also failed") }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    expect(result).toContain("Shutdown requested")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })
})

describe("team_cleanup", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("archives team when all members are shutdown", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")

    // Registry should be cleared
    expect(deps.registry.isTeamSession("sess-alice")).toBe(false)
  })

  test("rejects if active members exist and force=false", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    await expect(executeTeamCleanup(deps, { force: false }, "lead-sess"))
      .rejects.toThrow("still active")
  })

  test("force=true aborts active members and archives", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    insertMember(deps.db, "t1", "bob", "sess-bob", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")

    const result = await executeTeamCleanup(deps, { force: true }, "lead-sess")
    expect(result).toContain("cleaned up")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1) // only alice was active

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  test("rejects if caller is not the lead", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    await expect(executeTeamCleanup(deps, { force: false }, "sess-alice"))
      .rejects.toThrow("Only the team lead")
  })

  test("works with no members", async () => {
    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")
  })

  test("treats shutdown_requested members as inactive (cleanup succeeds without force)", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown_requested", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  test("treats error members as inactive (cleanup succeeds without force)", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "error", "failed")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  // --- Worktree cleanup tests ---

  test("removes worktrees and lists branches for merging on cleanup", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")
    expect(result).toContain("git merge ensemble-my-team-alice")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)
  })

  test("cleanup continues if worktree removal fails", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    deps.client.worktree.remove = async () => { throw new Error("worktree gone") }

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")
    expect(result).toContain("git merge")
  })

  test("cleanup with no worktrees does not mention branches", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("cleaned up")
    expect(result).not.toContain("git merge")
  })

  test("cleanup lists multiple branches when multiple members have worktrees", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    insertMember(deps.db, "t1", "bob", "sess-bob", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'bob'",
      ["/tmp/wt-bob", "ensemble-my-team-bob"])
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess")
    expect(result).toContain("ensemble-my-team-alice")
    expect(result).toContain("ensemble-my-team-bob")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(2)
  })
})
