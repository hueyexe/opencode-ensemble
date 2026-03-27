import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "../src/schema"
import { sendMessage, broadcastMessage, getUndeliveredMessages, markDelivered } from "../src/messaging"
import { setupDb as sharedSetupDb, insertTeam, insertMember, mockClient } from "./helpers"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  // Insert a team for FK constraints
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["t1", "my-team", "lead-sess", "active", 0, Date.now(), Date.now()]
  )
  // Insert members
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["t1", "alice", "sess-alice", "build", "ready", "idle", Date.now(), Date.now()]
  )
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["t1", "bob", "sess-bob", "build", "ready", "idle", Date.now(), Date.now()]
  )
  return db
}

describe("sendMessage", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
  })

  test("inserts a row into team_message", () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    const rows = db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_name).toBe("alice")
    expect(rows[0]!.to_name).toBe("bob")
    expect(rows[0]!.content).toBe("hello")
    expect(rows[0]!.delivered).toBe(0)
  })

  test("returns the message ID", () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("rejects messages over 10KB", () => {
    const bigContent = "x".repeat(10241)
    expect(() => sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: bigContent }))
      .toThrow("Message content exceeds 10KB limit")
  })

  test("accepts content at exactly 10KB boundary", () => {
    const exactContent = "x".repeat(10 * 1024)
    expect(() => sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: exactContent }))
      .not.toThrow()
  })

  test("measures size in bytes not characters (multi-byte)", () => {
    // Each emoji is 4 bytes in UTF-8; 2561 emojis = 10244 bytes > 10KB
    const multiByteContent = "😀".repeat(2561)
    expect(() => sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: multiByteContent }))
      .toThrow("Message content exceeds 10KB limit")
  })
})

describe("broadcastMessage", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
  })

  test("inserts a row with null to_name", () => {
    broadcastMessage(db, { teamId: "t1", from: "alice", content: "hey all" })
    const rows = db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.to_name).toBeNull()
    expect(rows[0]!.content).toBe("hey all")
  })

  test("returns the message ID", () => {
    const id = broadcastMessage(db, { teamId: "t1", from: "alice", content: "hey all" })
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("rejects broadcast messages over 10KB", () => {
    const bigContent = "x".repeat(10241)
    expect(() => broadcastMessage(db, { teamId: "t1", from: "alice", content: bigContent }))
      .toThrow("Message content exceeds 10KB limit")
  })

  test("accepts broadcast content at exactly 10KB boundary", () => {
    const exactContent = "x".repeat(10 * 1024)
    expect(() => broadcastMessage(db, { teamId: "t1", from: "alice", content: exactContent }))
      .not.toThrow()
  })
})

describe("getUndeliveredMessages", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
  })

  test("returns messages with delivered=0", () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg2" })
    const undelivered = getUndeliveredMessages(db, "t1")
    expect(undelivered).toHaveLength(2)
  })

  test("does not return delivered messages", () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    markDelivered(db, id)
    const undelivered = getUndeliveredMessages(db, "t1")
    expect(undelivered).toHaveLength(0)
  })

  test("returns empty array when no messages exist", () => {
    const undelivered = getUndeliveredMessages(db, "t1")
    expect(undelivered).toHaveLength(0)
    expect(undelivered).toEqual([])
  })

  test("filters by teamId (cross-team isolation)", () => {
    // Insert a second team
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 0, ?, ?)",
      ["t2", "other-team", "lead-sess-2", "active", Date.now(), Date.now()]
    )
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "for t1" })
    sendMessage(db, { teamId: "t2", from: "alice", to: "bob", content: "for t2" })
    const t1Messages = getUndeliveredMessages(db, "t1")
    const t2Messages = getUndeliveredMessages(db, "t2")
    expect(t1Messages).toHaveLength(1)
    expect(t1Messages[0]!.content).toBe("for t1")
    expect(t2Messages).toHaveLength(1)
    expect(t2Messages[0]!.content).toBe("for t2")
  })

  test("returns messages ordered by time_created ASC", () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "first" })
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "second" })
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "third" })
    const undelivered = getUndeliveredMessages(db, "t1")
    expect(undelivered).toHaveLength(3)
    expect(undelivered[0]!.content).toBe("first")
    expect(undelivered[1]!.content).toBe("second")
    expect(undelivered[2]!.content).toBe("third")
  })

  test("includes broadcast messages (to_name=NULL)", () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "direct" })
    broadcastMessage(db, { teamId: "t1", from: "alice", content: "broadcast" })
    const undelivered = getUndeliveredMessages(db, "t1")
    expect(undelivered).toHaveLength(2)
    const broadcast = undelivered.find(m => m.to_name === null)
    expect(broadcast).toBeDefined()
    expect(broadcast!.content).toBe("broadcast")
  })

  test("returns correct MessageRow shape", () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    const [msg] = getUndeliveredMessages(db, "t1")
    expect(msg).toBeDefined()
    expect(msg!.id).toMatch(/^msg_/)
    expect(msg!.team_id).toBe("t1")
    expect(msg!.from_name).toBe("alice")
    expect(msg!.to_name).toBe("bob")
    expect(msg!.content).toBe("hello")
    expect(msg!.delivered).toBe(0)
    expect(typeof msg!.time_created).toBe("number")
  })
})

describe("markDelivered", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
  })

  test("sets delivered=1 for the given message ID", () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    markDelivered(db, id)
    const row = db.query("SELECT delivered FROM team_message WHERE id = ?").get(id) as { delivered: number }
    expect(row.delivered).toBe(1)
  })

  test("does not throw for non-existent message ID", () => {
    expect(() => markDelivered(db, "msg_nonexistent")).not.toThrow()
  })

  test("only marks the targeted message as delivered", () => {
    const id1 = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    const id2 = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg2" })
    markDelivered(db, id1)
    const row1 = db.query("SELECT delivered FROM team_message WHERE id = ?").get(id1) as { delivered: number }
    const row2 = db.query("SELECT delivered FROM team_message WHERE id = ?").get(id2) as { delivered: number }
    expect(row1.delivered).toBe(1)
    expect(row2.delivered).toBe(0)
  })

  test("is idempotent — marking already-delivered message does not throw", () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    markDelivered(db, id)
    expect(() => markDelivered(db, id)).not.toThrow()
    const row = db.query("SELECT delivered FROM team_message WHERE id = ?").get(id) as { delivered: number }
    expect(row.delivered).toBe(1)
  })
})
