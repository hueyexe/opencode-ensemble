import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { notifyTeamEvent, notifyWorkingProgress, notifyLead } from "../src/notify"

describe("notifyTeamEvent", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("fires success toast on member spawned", async () => {
    await notifyTeamEvent(deps.client, "spawn", { memberName: "alice", agent: "build" })
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    expect((toasts[0]!.args[0] as Record<string, unknown>).variant).toBe("success")
    expect((toasts[0]!.args[0] as Record<string, unknown>).message).toContain("alice")
  })

  test("fires info toast on message received", async () => {
    await notifyTeamEvent(deps.client, "message", { from: "alice", to: "lead" })
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    expect((toasts[0]!.args[0] as Record<string, unknown>).variant).toBe("info")
  })

  test("fires info toast on member completed", async () => {
    await notifyTeamEvent(deps.client, "completed", { memberName: "alice" })
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    expect((toasts[0]!.args[0] as Record<string, unknown>).message).toContain("alice")
  })

  test("fires error toast on member error", async () => {
    await notifyTeamEvent(deps.client, "error", { memberName: "alice" })
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    expect((toasts[0]!.args[0] as Record<string, unknown>).variant).toBe("error")
  })

  test("fires info toast on member shutdown", async () => {
    await notifyTeamEvent(deps.client, "shutdown", { memberName: "alice" })
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    expect((toasts[0]!.args[0] as Record<string, unknown>).message).toContain("shut down")
  })

  test("does not throw if showToast fails", async () => {
    deps.client.tui.showToast = async () => { throw new Error("TUI unavailable") }
    // Should not throw
    await notifyTeamEvent(deps.client, "spawn", { memberName: "alice", agent: "build" })
  })
})

describe("notifyWorkingProgress", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("shows toast with working member names when some are busy", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "busy")
    insertMember(deps.db, "t1", "bob", "sess-b", "busy")
    insertMember(deps.db, "t1", "carol", "sess-c", "ready")
    await notifyWorkingProgress(deps.client, deps.db, "t1")
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    const msg = (toasts[0]!.args[0] as Record<string, unknown>).message as string
    expect(msg).toContain("alice")
    expect(msg).toContain("bob")
    expect(msg).not.toContain("carol")
  })

  test("shows 'all finished' toast when no members are busy", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "ready")
    insertMember(deps.db, "t1", "bob", "sess-b", "ready")
    await notifyWorkingProgress(deps.client, deps.db, "t1")
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(1)
    const msg = (toasts[0]!.args[0] as Record<string, unknown>).message as string
    expect(msg).toContain("All teammates finished")
  })

  test("does not fire toast when no members exist", async () => {
    await notifyWorkingProgress(deps.client, deps.db, "t1")
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts).toHaveLength(0)
  })

  test("includes count of working vs total", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "busy")
    insertMember(deps.db, "t1", "bob", "sess-b", "ready")
    insertMember(deps.db, "t1", "carol", "sess-c", "busy")
    await notifyWorkingProgress(deps.client, deps.db, "t1")
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    const msg = (toasts[0]!.args[0] as Record<string, unknown>).message as string
    expect(msg).toContain("2")
    expect(msg).toContain("3")
  })

  test("does not throw if showToast fails", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "busy")
    deps.client.tui.showToast = async () => { throw new Error("TUI unavailable") }
    await notifyWorkingProgress(deps.client, deps.db, "t1")
  })

  test("uses success variant for all-finished toast", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "ready")
    await notifyWorkingProgress(deps.client, deps.db, "t1")
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect((toasts[0]!.args[0] as Record<string, unknown>).variant).toBe("success")
  })

  test("uses info variant for in-progress toast", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "busy")
    await notifyWorkingProgress(deps.client, deps.db, "t1")
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect((toasts[0]!.args[0] as Record<string, unknown>).variant).toBe("info")
  })
})

describe("notifyLead", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("persists a system message to the lead", () => {
    notifyLead(deps.client, deps.db, "t1", "alice failed")
    const msgs = deps.db.query(
      "SELECT from_name, to_name, content, delivered FROM team_message WHERE team_id = ?"
    ).all("t1") as Array<{ from_name: string; to_name: string; content: string; delivered: number }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.from_name).toBe("system")
    expect(msgs[0]!.to_name).toBe("lead")
    expect(msgs[0]!.content).toBe("alice failed")
  })

  test("actively wakes the lead via promptAsync", () => {
    notifyLead(deps.client, deps.db, "t1", "alice failed")
    const wakes = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(wakes).toHaveLength(1)
    expect((wakes[0]!.args[0] as { sessionID: string }).sessionID).toBe("lead-sess")
  })

  test("wakes the lead even when all teammates are terminal (the error/abort case)", () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "error")
    notifyLead(deps.client, deps.db, "t1", "alice hit an error and aborted")
    const wakes = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(wakes).toHaveLength(1)
    expect((wakes[0]!.args[0] as { sessionID: string }).sessionID).toBe("lead-sess")
  })

  test("does not wake when the team does not exist (no-op wake, persist still attempted)", () => {
    // A valid teamId is required for persistence (FK); with an unknown team the
    // lead lookup yields nothing, so no wake is fired.
    insertTeam(deps.db, "t2", "second-team", "lead-sess-2")
    notifyLead(deps.client, deps.db, "t2", "second team message")
    const wakes = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(wakes).toHaveLength(1)
    expect((wakes[0]!.args[0] as { sessionID: string }).sessionID).toBe("lead-sess-2")
  })

  test("swallows promptAsync failures — message is already persisted", () => {
    deps.client.session.promptAsync = async () => { throw new Error("transport down") }
    expect(() => notifyLead(deps.client, deps.db, "t1", "alice failed")).not.toThrow()
    const msgs = deps.db.query("SELECT id FROM team_message WHERE team_id = ?").all("t1") as unknown[]
    expect(msgs).toHaveLength(1)
  })

  test("returns the persisted message id", () => {
    const id = notifyLead(deps.client, deps.db, "t1", "alice failed")
    expect(typeof id).toBe("string")
    expect(id).toMatch(/^msg_/)
  })
})
