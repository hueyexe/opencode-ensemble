import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "../src/schema"
import { sendMessage, broadcastMessage, getUndeliveredMessages, markDelivered } from "../src/messaging"

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
})
