import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { notifyTeamEvent } from "../src/notify"

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
