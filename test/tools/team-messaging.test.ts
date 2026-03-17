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
