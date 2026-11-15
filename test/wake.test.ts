import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { sendMessage, markDelivered } from "../src/messaging"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamResults } from "../src/tools/team-results"
import { wakeLeadIfPending, resetWakeState } from "../src/wake"

type Deps = ReturnType<typeof setupDeps>

/** Flush the fire-and-forget wake helper's microtasks. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function wakes(deps: Deps): Array<{ sessionID: string; parts: Array<{ text: string }>; synthetic?: boolean }> {
  return deps.client.calls
    .filter(c => c.method === "session.promptAsync")
    .map(c => c.args[0] as { sessionID: string; parts: Array<{ text: string }>; synthetic?: boolean })
}

describe("wakeLeadIfPending (issues #48, #57)", () => {
  let deps: Deps

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("wakes an idle lead when there are unseen messages", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(true)

    const calls = wakes(deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionID).toBe("lead-sess")
    expect(calls[0]!.synthetic).toBe(true)
    expect(calls[0]!.parts[0]!.text).toContain("1 new team message")
    expect(calls[0]!.parts[0]!.text).toContain("team_results")
  })

  test("does not wake when the team no longer exists (purge race, #48)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.db.run("DELETE FROM team WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not wake when the team is archived (cleanup race, #48)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not wake when all messages were already auto-delivered", async () => {
    const id = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    markDelivered(deps.db, id)

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not wake when the inbox was drained via team_results", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    await executeTeamResults(deps, {}, "lead-sess")
    resetWakeState(deps.db)

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("does not queue a wake behind a busy lead", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.client.session.status = async () => ({ data: { "lead-sess": { type: "busy" } } })

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1")
    expect(sent).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("force sends even when the lead is busy (system/error notifications)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "system", to: "lead", content: "alice failed" })
    deps.client.session.status = async () => ({ data: { "lead-sess": { type: "busy" } } })

    const sent = await wakeLeadIfPending(deps.client, deps.db, "t1", { force: true })
    expect(sent).toBe(true)
    expect(wakes(deps)).toHaveLength(1)
  })

  test("coalesces concurrent wakes into one", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "one" })
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "two" })

    await Promise.all([
      wakeLeadIfPending(deps.client, deps.db, "t1"),
      wakeLeadIfPending(deps.client, deps.db, "t1"),
    ])
    expect(wakes(deps)).toHaveLength(1)
  })

  test("re-checks team state after the status lookup (cleanup between schedule and send)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })

    let releaseStatus: (() => void) | undefined
    deps.client.session.status = () => new Promise((resolve) => {
      releaseStatus = () => resolve({ data: {} })
    })

    const pending = wakeLeadIfPending(deps.client, deps.db, "t1")
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")
    releaseStatus!()

    expect(await pending).toBe(false)
    expect(wakes(deps)).toHaveLength(0)
  })

  test("never throws when the transport fails", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.client.session.status = async () => { throw new Error("status down") }

    await expect(wakeLeadIfPending(deps.client, deps.db, "t1")).resolves.toBe(true)
    expect(wakes(deps)).toHaveLength(1)
  })

  test("preserves the lead's current agent and model on V1 wakes (#37)", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "done" })
    deps.client.session.messages = async () => ({
      data: [{
        info: { role: "user", agent: "plan", model: { providerID: "anthropic", modelID: "claude-sonnet" } },
        parts: [{ type: "text", text: "stay in plan mode" }],
      }],
    })

    await wakeLeadIfPending(deps.client, deps.db, "t1")

    const call = wakes(deps)[0] as { agent?: string; model?: unknown }
    expect(call.agent).toBe("plan")
    expect(call.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
  })
})

describe("team_message wake coalescing (issue #57)", () => {
  let deps: Deps

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("two messages sent back-to-back produce at most one wake", async () => {
    await executeTeamMessage(deps, { to: "lead", text: "first" }, "sess-alice")
    await executeTeamMessage(deps, { to: "lead", text: "second" }, "sess-alice")
    await flush()

    expect(wakes(deps)).toHaveLength(1)
  })

  test("does not produce a second wake after the inbox is drained", async () => {
    await executeTeamMessage(deps, { to: "lead", text: "first" }, "sess-alice")
    await executeTeamMessage(deps, { to: "lead", text: "second" }, "sess-alice")
    await executeTeamResults(deps, {}, "lead-sess")
    await flush()

    // The first wake may already have fired before the drain; it must not be
    // followed by a second empty wake.
    expect(wakes(deps).length).toBeLessThanOrEqual(1)
  })
})
