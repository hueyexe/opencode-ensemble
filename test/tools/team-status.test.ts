import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamStatus, lastCallTime } from "../../src/tools/team-status"

describe("team_status", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    lastCallTime.clear()
  })

  test("shows team with no members", async () => {
    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("my-team")
    expect(result).toContain("No teammates")
  })

  test("shows members with status and agent", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    insertMember(deps.db, "t1", "bob", "sess-bob", "ready", "idle")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")

    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("alice")
    expect(result).toContain("bob")
    expect(result).toContain("working")
    expect(result).toContain("idle")
    expect(result).toContain("build")
  })

  test("works for teammates too", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamStatus(deps, "sess-alice")
    expect(result).toContain("my-team")
  })

  test("fires a toast with member summary", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    insertMember(deps.db, "t1", "bob", "sess-bob", "ready", "idle")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")

    await executeTeamStatus(deps, "lead-sess")

    const toastCall = deps.client.calls.find(c => c.method === "tui.showToast")
    expect(toastCall).toBeDefined()
    const opts = toastCall!.args[0] as { title: string; message: string; variant: string }
    expect(opts.title).toBe("Team")
    expect(opts.variant).toBe("info")
    expect(opts.message).toContain("alice")
    expect(opts.message).toContain("working")
    expect(opts.message).toContain("bob")
    expect(opts.message).toContain("idle")
  })

  test("toast includes task counts when tasks exist", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    const now = Date.now()
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task1", "t1", "Fix bug", "completed", "high", now, now]
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task2", "t1", "Write docs", "pending", "medium", now, now]
    )

    await executeTeamStatus(deps, "lead-sess")

    const toastCall = deps.client.calls.find(c => c.method === "tui.showToast")
    expect(toastCall).toBeDefined()
    const opts = toastCall!.args[0] as { message: string }
    expect(opts.message).toContain("1/2 done")
  })

  test("toast not fired when no members exist", async () => {
    await executeTeamStatus(deps, "lead-sess")

    const toastCall = deps.client.calls.find(c => c.method === "tui.showToast")
    expect(toastCall).toBeUndefined()
  })

  test("toast swallows errors silently", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "ready", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    // Make showToast throw
    deps.client.tui.showToast = async () => { throw new Error("TUI unavailable") }

    // Should not throw
    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("alice")
  })

  test("returns rate-limited message when called twice within 30s for same team", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    const first = await executeTeamStatus(deps, "lead-sess")
    expect(first).toContain("alice")

    const second = await executeTeamStatus(deps, "lead-sess")
    expect(second).toBe("No changes since last check.")
  })

  test("returns normal status after 30s (manipulate lastCallTime)", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    const first = await executeTeamStatus(deps, "lead-sess")
    expect(first).toContain("alice")

    // Simulate 31 seconds passing
    lastCallTime.set("t1", Date.now() - 31_000)

    const second = await executeTeamStatus(deps, "lead-sess")
    expect(second).toContain("alice")
    expect(second).not.toContain("No changes")
  })

  test("normal response contains team info without LLM instructions", async () => {
    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("Team: my-team")
    expect(result).not.toContain("Relay")
    expect(result).not.toContain("STOP")
  })

  test("rate-limited response is clean without LLM instructions", async () => {
    const first = await executeTeamStatus(deps, "lead-sess")
    const second = await executeTeamStatus(deps, "lead-sess")
    expect(second).toBe("No changes since last check.")
    expect(second).not.toContain("STOP")
    expect(second).not.toContain("do not call")
  })

  test("shows plan_approval when not none", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("alice")
    expect(result).toContain("plan: pending")
  })

  test("shows plan: approved for approved members", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.db.run("UPDATE team_member SET plan_approval = 'approved' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("plan: approved")
  })

  test("does not show plan info when plan_approval is none", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).not.toContain("plan:")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamStatus(deps, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("shows task summary", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    // Add some tasks
    const now = Date.now()
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task1", "t1", "Fix bug", "in_progress", "high", now, now]
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task2", "t1", "Write docs", "pending", "medium", now, now]
    )

    const result = await executeTeamStatus(deps, "lead-sess")
    expect(result).toContain("2 total")
  })
})
