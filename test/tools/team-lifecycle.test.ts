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

  test("busy member with default force=false sends shutdown message, no abort", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    expect(result).toContain("Shutdown requested")
    expect(result).toContain("alice")

    // Should send promptAsync with shutdown message, NOT abort
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })

  test("idle member is aborted immediately, no promptAsync", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    expect(result).toContain("shut down")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
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

  test("handles abort failure gracefully on idle member", async () => {
    // Status says idle, so we try to abort, but abort fails
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }
    deps.client.session.abort = async () => { throw new Error("session gone") }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    // Should still transition to shutdown since member was idle
    expect(result).toContain("shut down")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("falls back to shutdown_requested when status poll fails", async () => {
    deps.client.session.status = async () => { throw new Error("status failed") }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    // Can't determine idle/busy, so treat as busy → graceful shutdown
    expect(result).toContain("Shutdown requested")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })

  test("busy member with force=true aborts immediately, no promptAsync", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice", force: true }, "lead-sess")
    expect(result).toContain("shut down")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("member already shutdown_requested → second call forces abort", async () => {
    // Set alice to shutdown_requested (as if first graceful call already happened)
    deps.db.run("UPDATE team_member SET status = 'shutdown_requested' WHERE name = 'alice'")

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")
    expect(result).toContain("Force shut down")
    expect(result).toContain("alice")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("shutdown message content contains [Shutdown requested] and instructions", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    await executeTeamShutdown(deps, { member: "alice" }, "lead-sess")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const body = (promptCalls[0]!.args[0] as Record<string, unknown>).body as Record<string, unknown>
    const parts = body.parts as Array<{ text: string }>
    const text = parts[0]!.text
    expect(text).toContain("[Shutdown requested]")
    expect(text).toContain("team_message")
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
