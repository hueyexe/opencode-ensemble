import { describe, test, expect } from "bun:test"
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
