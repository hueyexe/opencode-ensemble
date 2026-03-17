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
})
