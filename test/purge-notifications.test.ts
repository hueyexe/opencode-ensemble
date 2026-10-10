import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { handleSessionStatusEvent } from "../src/hooks"
import { notifyLead } from "../src/notify"
import { dispatchV2Event } from "../src/v2-events"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamCleanup } from "../src/tools/team-cleanup"

describe("purge notification leak (issue #40 Bug 4)", () => {
  test("notifyLead does not wake lead for archived team", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    // Archive the team
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])

    const id = notifyLead(deps.client, deps.db, "t1", "Teammate alpha finished")
    // notifyLead is fire-and-forget promptAsync — give microtask a tick
    await new Promise(r => setTimeout(r, 10))
    const after = deps.client.calls.filter(c => c.method === "session.promptAsync")
    // Should NOT have woken the lead for an archived team — no wake, no persist
    expect(after.length).toBe(0)
    expect(id).toBe("")
  })

  test("notifyLead does not wake lead for purged (deleted) team", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alpha", "ses-alpha")
    // Simulate purge: delete team (cascades members/messages)
    deps.db.run("DELETE FROM team WHERE id = ?", ["t1"])
    deps.registry.unregisterTeam("t1")

    const id = notifyLead(deps.client, deps.db, "t1", "Teammate alpha stalled")
    await new Promise(r => setTimeout(r, 10))
    const wakes = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(wakes.length).toBe(0)
    expect(id).toBe("") // no message persisted for purged team
  })

  test("handleSessionStatusEvent ignores events for archived team", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alpha", "ses-alpha", "busy", "running")
    deps.registry.register("t1", "alpha", "ses-alpha")
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])

    const transition = handleSessionStatusEvent(deps.db, deps.registry, "ses-alpha", "idle")
    expect(transition).toBeUndefined()
    const row = deps.db.query("SELECT status FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alpha") as { status: string }
    // Status should remain busy — not transitioned to ready/shutdown
    expect(row.status).toBe("busy")
  })

  test("handleSessionStatusEvent ignores events for deleted (purged) team", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alpha", "ses-alpha", "busy", "running")
    deps.registry.register("t1", "alpha", "ses-alpha")
    deps.db.run("DELETE FROM team WHERE id = ?", ["t1"])
    // Registry still has entry, but DB team gone
    const transition = handleSessionStatusEvent(deps.db, deps.registry, "ses-alpha", "idle")
    expect(transition).toBeUndefined()
  })

  test("dispatchV2Event ignores session.status for archived team", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alpha", "ses-alpha", "busy", "running")
    deps.registry.register("t1", "alpha", "ses-alpha")
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])

    const transition = dispatchV2Event(deps.db, deps.registry, deps.tracker, {
      type: "session.status",
      data: { sessionID: "ses-alpha", status: "idle" },
    })
    expect(transition).toBeUndefined()
  })

  test("team_message to lead does not wake after team archived", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alpha", "ses-alpha", "busy", "running")
    deps.registry.register("t1", "alpha", "ses-alpha")
    // Archive team before message
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])

    // Alpha tries to message lead after archive — should be rejected, not wake
    await expect(executeTeamMessage(deps, { to: "lead", text: "done" }, "ses-alpha")).rejects.toThrow("not in a team")
    await new Promise(r => setTimeout(r, 10))
    const wakes = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(wakes.length).toBe(0)
  })

  test("purge removes registry entries so future status events are ignored", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "old-team", "lead-old")
    insertMember(deps.db, "t1", "alpha", "ses-alpha", "shutdown", "idle")
    deps.registry.register("t1", "alpha", "ses-alpha")
    // Archive then purge via direct DB delete (simulating team_cleanup purge)
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    // Purge path unregisters
    deps.db.run("DELETE FROM team WHERE id = ?", ["t1"])
    deps.registry.unregisterTeam("t1")

    // Future event for same session should be ignored (no registry entry)
    const transition = handleSessionStatusEvent(deps.db, deps.registry, "ses-alpha", "busy")
    expect(transition).toBeUndefined()
    expect(deps.registry.getBySession("ses-alpha")).toBeUndefined()
  })
})
