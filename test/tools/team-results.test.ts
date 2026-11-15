import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamResults } from "../../src/tools/team-results"
import { sendMessage, broadcastMessage } from "../../src/messaging"

describe("team_results", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("returns unread messages and marks them as read", async () => {
    // Insert messages via sendMessage, then mark delivered
    const msgId1 = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "task done" })
    const msgId2 = sendMessage(deps.db, { teamId: "t1", from: "bob", to: "lead", content: "need help" })
    deps.db.run("UPDATE team_message SET delivered = 1 WHERE id IN (?, ?)", [msgId1, msgId2])

    const result = await executeTeamResults(deps, {}, "lead-sess")

    expect(result).toContain("alice")
    expect(result).toContain("task done")
    expect(result).toContain("bob")
    expect(result).toContain("need help")

    // Verify messages are now marked as read
    const unread = deps.db.query("SELECT COUNT(*) as cnt FROM team_message WHERE team_id = ? AND read = 0").get("t1") as { cnt: number }
    expect(unread.cnt).toBe(0)
  })

  test("returns 'No unread messages.' when none exist", async () => {
    const result = await executeTeamResults(deps, {}, "lead-sess")
    expect(result).toBe("No unread messages.")
  })

  test("filters by from_name when args.from is provided", async () => {
    const msgId1 = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "from alice" })
    const msgId2 = sendMessage(deps.db, { teamId: "t1", from: "bob", to: "lead", content: "from bob" })
    deps.db.run("UPDATE team_message SET delivered = 1 WHERE id IN (?, ?)", [msgId1, msgId2])

    const result = await executeTeamResults(deps, { from: "alice" }, "lead-sess")

    expect(result).toContain("alice")
    expect(result).toContain("from alice")
    expect(result).not.toContain("from bob")

    // Only alice's message should be marked read
    const aliceRead = deps.db.query("SELECT read FROM team_message WHERE id = ?").get(msgId1) as { read: number }
    expect(aliceRead.read).toBe(1)
    const bobRead = deps.db.query("SELECT read FROM team_message WHERE id = ?").get(msgId2) as { read: number }
    expect(bobRead.read).toBe(0)
  })

  test("a teammate cannot drain the lead's inbox", async () => {
    const leadMsg = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "for the lead" })
    const bobMsg = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "for bob" })

    const result = await executeTeamResults(deps, {}, "sess-bob")

    expect(result).toContain("for bob")
    expect(result).not.toContain("for the lead")
    const leadRow = deps.db.query("SELECT read FROM team_message WHERE id = ?").get(leadMsg) as { read: number }
    expect(leadRow.read).toBe(0)
    const bobRow = deps.db.query("SELECT read FROM team_message WHERE id = ?").get(bobMsg) as { read: number }
    expect(bobRow.read).toBe(1)
  })

  test("broadcasts remain visible via team_results", async () => {
    const id = broadcastMessage(deps.db, { teamId: "t1", from: "alice", content: "team-wide update" })

    const bobResult = await executeTeamResults(deps, {}, "sess-bob")
    expect(bobResult).toContain("team-wide update")

    const row = deps.db.query("SELECT read FROM team_message WHERE id = ?").get(id) as { read: number }
    expect(row.read).toBe(1)
  })

  test("does not return already-read messages", async () => {
    const msgId = sendMessage(deps.db, { teamId: "t1", from: "alice", to: "lead", content: "old message" })
    deps.db.run("UPDATE team_message SET delivered = 1, read = 1 WHERE id = ?", [msgId])

    const result = await executeTeamResults(deps, {}, "lead-sess")
    expect(result).toBe("No unread messages.")
  })

  test("returns messages ordered by time_created ASC", async () => {
    // Insert with explicit time ordering
    const now = Date.now()
    deps.db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created) VALUES (?, ?, ?, ?, ?, 1, 0, ?)",
      ["msg-late", "t1", "bob", "lead", "second message", now + 100],
    )
    deps.db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created) VALUES (?, ?, ?, ?, ?, 1, 0, ?)",
      ["msg-early", "t1", "alice", "lead", "first message", now],
    )

    const result = await executeTeamResults(deps, {}, "lead-sess")

    const aliceIdx = result.indexOf("first message")
    const bobIdx = result.indexOf("second message")
    expect(aliceIdx).toBeLessThan(bobIdx)
  })

  test("rejects if session is not in a team", async () => {
    await expect(executeTeamResults(deps, {}, "random-sess"))
      .rejects.toThrow("not in a team")
  })
})
