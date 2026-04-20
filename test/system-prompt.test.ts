import { describe, test, expect, beforeEach } from "bun:test"
import { setupDb, insertTeam, insertMember } from "./helpers"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "../src/system-prompt"
import type { Database } from "bun:sqlite"

function insertTask(db: Database, teamId: string, id: string, status: string, priority = "medium") {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, teamId, `Task ${id}`, status, priority, Date.now(), Date.now()],
  )
}

describe("buildLeadSystemPrompt", () => {
  test("includes team name, member names+statuses, task counts, and anti-polling guidance", () => {
    const db = setupDb()
    insertTeam(db, "t1", "alpha", "lead-sess")
    insertMember(db, "t1", "alice", "sess-a", "busy")
    insertMember(db, "t1", "bob", "sess-b", "ready")
    insertTask(db, "t1", "task-1", "completed")
    insertTask(db, "t1", "task-2", "in_progress")
    insertTask(db, "t1", "task-3", "pending")

    const result = buildLeadSystemPrompt(db, "t1")

    expect(result).toContain('"alpha"')
    expect(result).toContain("alice")
    expect(result).toContain("bob")
    expect(result).toContain("working") // busy → working
    expect(result).toContain("idle") // ready → idle
    expect(result).toContain("1 completed")
    expect(result).toContain("1 in progress")
    expect(result).toContain("1 pending")
    expect(result).toContain("wait for messages")
  })

  test("handles empty team with no members and no tasks", () => {
    const db = setupDb()
    insertTeam(db, "t2", "empty-team", "lead-sess")

    const result = buildLeadSystemPrompt(db, "t2")

    expect(result).toContain('"empty-team"')
    expect(result).toContain("0 completed")
    expect(result).toContain("0 in progress")
    expect(result).toContain("0 pending")
  })

  test("shows error status for member in error state", () => {
    const db = setupDb()
    insertTeam(db, "t3", "err-team", "lead-sess")
    insertMember(db, "t3", "carol", "sess-c", "error")

    const result = buildLeadSystemPrompt(db, "t3")

    expect(result).toContain("carol")
    expect(result).toContain("error")
  })

  test("shows shutdown_requested member as 'shutting down'", () => {
    const db = setupDb()
    insertTeam(db, "t4", "shutdown-team", "lead-sess")
    insertMember(db, "t4", "dave", "sess-d", "shutdown_requested")

    const result = buildLeadSystemPrompt(db, "t4")

    expect(result).toContain("dave")
    expect(result).toContain("shutting down")
  })

  test("includes one-at-a-time spawn guidance", () => {
    const db = setupDb()
    insertTeam(db, "t5", "seq-team", "lead-sess")

    const result = buildLeadSystemPrompt(db, "t5")

    expect(result).toMatch(/one.*at a time/i)
    expect(result).toMatch(/worktree contention/i)
  })

  test("delivers pending messages inline in system prompt and marks them delivered", () => {
    const db = setupDb()
    insertTeam(db, "t6", "msg-team", "lead-sess")
    insertMember(db, "t6", "alice", "sess-a")

    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ["m1", "t6", "alice", "lead", "done", Date.now()])
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ["m2", "t6", "alice", "lead", "also done", Date.now()])

    const result = buildLeadSystemPrompt(db, "t6")

    expect(result).toContain("--- Team Messages ---")
    expect(result).toContain("[From alice]: done")
    expect(result).toContain("[From alice]: also done")

    // Messages should now be marked delivered
    const undelivered = db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = 't6' AND delivered = 0").get() as { c: number }
    expect(undelivered.c).toBe(0)
  })

  test("does not show messages section when no undelivered messages", () => {
    const db = setupDb()
    insertTeam(db, "t7", "clean-team", "lead-sess")

    const result = buildLeadSystemPrompt(db, "t7")

    expect(result).not.toContain("Team Messages")
  })
})

describe("buildTeammateSystemPrompt", () => {
  test("returns correct name and team name", () => {
    const db = setupDb()
    insertTeam(db, "t1", "bravo", "lead-sess")

    const result = buildTeammateSystemPrompt(db, "t1", "alice")

    expect(result).toContain('"alice"')
    expect(result).toContain('"bravo"')
    expect(result).toContain("team_message")
  })

  test("different member name produces different output", () => {
    const db = setupDb()
    insertTeam(db, "t1", "bravo", "lead-sess")

    const resultA = buildTeammateSystemPrompt(db, "t1", "alice")
    const resultB = buildTeammateSystemPrompt(db, "t1", "bob")

    expect(resultA).not.toEqual(resultB)
    expect(resultA).toContain('"alice"')
    expect(resultB).toContain('"bob"')
  })
})

describe("buildTeamCompactionContext", () => {
  test("lead role includes 'you are the lead'", () => {
    const db = setupDb()
    insertTeam(db, "t1", "charlie", "lead-sess")
    insertMember(db, "t1", "alice", "sess-a", "busy")
    insertTask(db, "t1", "task-1", "completed")
    insertTask(db, "t1", "task-2", "in_progress")

    const result = buildTeamCompactionContext(db, "t1", "lead")

    expect(result).toContain("the lead")
    expect(result).toContain('"charlie"')
    expect(result).toContain("alice")
    expect(result).toContain("working")
    expect(result).toContain("1 completed")
    expect(result).toContain("1 in progress")
    expect(result).toContain("0 pending")
  })

  test("member role includes 'you are a teammate'", () => {
    const db = setupDb()
    insertTeam(db, "t1", "charlie", "lead-sess")

    const result = buildTeamCompactionContext(db, "t1", "member", "bob")

    expect(result).toContain("teammate")
    expect(result).toContain('"bob"')
    expect(result).toContain('"charlie"')
  })

  test("accurate member and task counts", () => {
    const db = setupDb()
    insertTeam(db, "t1", "delta", "lead-sess")
    insertMember(db, "t1", "alice", "sess-a", "ready")
    insertMember(db, "t1", "bob", "sess-b", "busy")
    insertMember(db, "t1", "carol", "sess-c", "shutdown")
    insertTask(db, "t1", "task-1", "completed")
    insertTask(db, "t1", "task-2", "completed")
    insertTask(db, "t1", "task-3", "in_progress")
    insertTask(db, "t1", "task-4", "pending")
    insertTask(db, "t1", "task-5", "pending")

    const result = buildTeamCompactionContext(db, "t1", "lead")

    expect(result).toContain("alice")
    expect(result).toContain("bob")
    expect(result).toContain("carol")
    expect(result).toContain("2 completed")
    expect(result).toContain("1 in progress")
    expect(result).toContain("2 pending")
  })
})

// --- Peer message delivery in teammate system prompt ---

describe("buildTeammateSystemPrompt peer messages", () => {
  let db: ReturnType<typeof setupDb>

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "test-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
    insertMember(db, "t1", "bob", "sess-bob", "busy", "running")
  })

  test("includes pending peer messages addressed to this teammate", () => {
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ["msg-1", "t1", "bob", "alice", "Hey alice, I found a bug in auth.ts", Date.now()])

    const result = buildTeammateSystemPrompt(db, "t1", "alice")
    expect(result).toContain("Messages for you")
    expect(result).toContain("bob")
    expect(result).toContain("found a bug")
  })

  test("does not include messages addressed to other teammates", () => {
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ["msg-1", "t1", "alice", "bob", "Message for bob only", Date.now()])

    const result = buildTeammateSystemPrompt(db, "t1", "alice")
    expect(result).not.toContain("Message for bob")
  })

  test("does not include already-delivered messages", () => {
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 1, ?)",
      ["msg-1", "t1", "bob", "alice", "Already delivered message", Date.now()])

    const result = buildTeammateSystemPrompt(db, "t1", "alice")
    expect(result).not.toContain("Already delivered")
  })

  test("marks messages as delivered after injection", () => {
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ["msg-1", "t1", "bob", "alice", "Peer message", Date.now()])

    buildTeammateSystemPrompt(db, "t1", "alice")

    const msg = db.query("SELECT delivered FROM team_message WHERE id = 'msg-1'").get() as { delivered: number }
    expect(msg.delivered).toBe(1)
  })

  test("returns basic prompt when no peer messages", () => {
    const result = buildTeammateSystemPrompt(db, "t1", "alice")
    expect(result).toContain("alice")
    expect(result).toContain("test-team")
    expect(result).not.toContain("Messages for you")
  })
})
