import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamMessage } from "../../src/tools/team-message"
import { executeTeamBroadcast } from "../../src/tools/team-broadcast"

describe("team_message", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("teammate sends message to lead", async () => {
    const result = await executeTeamMessage(deps, { to: "lead", text: "done with task" }, "sess-alice")
    expect(result).toContain("lead")

    // Check DB
    const rows = deps.db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_name).toBe("alice")
    expect(rows[0]!.to_name).toBe("lead")

    // Check promptAsync was called on lead session
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })

  test("teammate sends message to another teammate", async () => {
    const result = await executeTeamMessage(deps, { to: "bob", text: "need help" }, "sess-alice")
    expect(result).toContain("bob")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })

  test("lead sends message to teammate", async () => {
    const result = await executeTeamMessage(deps, { to: "alice", text: "check this" }, "lead-sess")
    expect(result).toContain("alice")
  })

  test("rejects if sender is not in a team", async () => {
    await expect(executeTeamMessage(deps, { to: "alice", text: "hi" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("rejects if recipient not found", async () => {
    await expect(executeTeamMessage(deps, { to: "unknown", text: "hi" }, "sess-alice"))
      .rejects.toThrow("not found")
  })

  test("rejects messages over 10KB", async () => {
    await expect(executeTeamMessage(deps, { to: "lead", text: "x".repeat(10241) }, "sess-alice"))
      .rejects.toThrow("10KB")
  })

  test("message to lead over 500 chars is truncated in promptAsync delivery", async () => {
    const longText = "a".repeat(600)
    await executeTeamMessage(deps, { to: "lead", text: longText }, "sess-alice")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const delivered = (promptCalls[0]!.args[0] as { body: { parts: Array<{ text: string }> } }).body.parts[0]!.text
    expect(delivered.length).toBeLessThan(longText.length + 50) // truncated, not full
    expect(delivered).toContain("...")
    expect(delivered).toContain("use team_results to read full message")
    // Must NOT contain the full original text
    expect(delivered).not.toContain(longText)
  })

  test("message to lead under 500 chars is delivered in full", async () => {
    const shortText = "b".repeat(400)
    await executeTeamMessage(deps, { to: "lead", text: shortText }, "sess-alice")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const delivered = (promptCalls[0]!.args[0] as { body: { parts: Array<{ text: string }> } }).body.parts[0]!.text
    expect(delivered).toContain(shortText)
    expect(delivered).not.toContain("use team_results to read full message")
  })

  test("message to teammate is always delivered in full regardless of size", async () => {
    const longText = "c".repeat(600)
    await executeTeamMessage(deps, { to: "bob", text: longText }, "sess-alice")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const delivered = (promptCalls[0]!.args[0] as { body: { parts: Array<{ text: string }> } }).body.parts[0]!.text
    expect(delivered).toContain(longText)
    expect(delivered).not.toContain("use team_results to read full message")
  })

  test("full content is stored in DB untruncated even when delivery is truncated", async () => {
    const longText = "d".repeat(600)
    await executeTeamMessage(deps, { to: "lead", text: longText }, "sess-alice")

    const rows = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").all("t1") as Array<{ content: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe(longText)
  })
})

describe("team_broadcast", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("broadcasts to all members + lead (excluding sender)", async () => {
    const result = await executeTeamBroadcast(deps, { text: "status update" }, "sess-alice")
    expect(result).toContain("Broadcast")

    // Should call promptAsync for bob + lead (not alice)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(2)

    // Check DB has one broadcast row
    const rows = deps.db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.to_name).toBeNull()
  })

  test("lead broadcasts to all members", async () => {
    const result = await executeTeamBroadcast(deps, { text: "new plan" }, "lead-sess")
    expect(result).toContain("Broadcast")

    // Should call promptAsync for alice + bob (not lead)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(2)
  })

  test("rejects if sender is not in a team", async () => {
    await expect(executeTeamBroadcast(deps, { text: "hi" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("does not mark message delivered when all deliveries fail", async () => {
    deps.client.session.promptAsync = async () => { throw new Error("delivery failed") }

    await executeTeamBroadcast(deps, { text: "status update" }, "sess-alice")

    // Message should remain undelivered in DB
    const rows = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.delivered).toBe(0)
  })

  test("marks message delivered when at least one delivery succeeds", async () => {
    let callCount = 0
    deps.client.session.promptAsync = async (opts: unknown) => {
      callCount++
      deps.client.calls.push({ method: "session.promptAsync", args: [opts] })
      // First call succeeds, second fails
      if (callCount === 2) throw new Error("delivery failed")
      return {}
    }

    await executeTeamBroadcast(deps, { text: "status update" }, "sess-alice")

    const rows = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.delivered).toBe(1)
  })
})

describe("team_message — plan approval", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("approve=true flips plan_approval from pending to approved and prepends tag", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    const result = await executeTeamMessage(deps, { to: "alice", text: "looks good", approve: true }, "lead-sess")
    expect(result).toContain("alice")

    // Check DB was updated
    const row = deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice") as { plan_approval: string }
    expect(row.plan_approval).toBe("approved")

    // Check message content was prepended
    const msgs = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").all("t1") as Array<{ content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toContain("[Plan Approved]")
    expect(msgs[0]!.content).toContain("looks good")
  })

  test("reject flips plan_approval from pending to rejected and prepends reason", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "bob"])

    const result = await executeTeamMessage(deps, { to: "bob", text: "try again", reject: "needs more detail" }, "lead-sess")
    expect(result).toContain("bob")

    const row = deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "bob") as { plan_approval: string }
    expect(row.plan_approval).toBe("rejected")

    const msgs = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").all("t1") as Array<{ content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toContain("[Plan Rejected: needs more detail]")
    expect(msgs[0]!.content).toContain("try again")
  })

  test("approve errors if recipient has plan_approval=none", async () => {
    // plan_approval defaults to 'none' from insertMember
    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true }, "lead-sess"))
      .rejects.toThrow("not in plan approval mode")
  })

  test("approve errors if recipient has plan_approval=approved (already approved)", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'approved' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true }, "lead-sess"))
      .rejects.toThrow("not in plan approval mode")
  })

  test("both approve and reject set returns error", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true, reject: "no" }, "lead-sess"))
      .rejects.toThrow("Cannot both approve and reject")
  })

  test("only lead can approve — member trying to approve errors", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true }, "sess-bob"))
      .rejects.toThrow("Only the lead can approve or reject")
  })
})
