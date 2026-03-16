import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "../src/schema"
import { MemberRegistry, DescendantTracker } from "../src/state"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation } from "../src/hooks"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  return db
}

function insertTeam(db: Database, id: string, name: string, leadSession: string, status = "active") {
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [id, name, leadSession, status, Date.now(), Date.now()]
  )
}

function insertMember(db: Database, teamId: string, name: string, sessionId: string, status: string, execStatus: string) {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', ?, ?, ?, ?)",
    [teamId, name, sessionId, status, execStatus, Date.now(), Date.now()]
  )
}

describe("handleSessionStatusEvent", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("transitions busy member to ready when session becomes idle", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "idle")

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("ready")
    expect(row.execution_status).toBe("idle")
  })

  test("transitions shutdown_requested member to shutdown when session becomes idle", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "running")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "idle")

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("shutdown")
    expect(row.execution_status).toBe("idle")
  })

  test("transitions ready member to busy when session becomes busy", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "ready", "idle")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "busy")

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("busy")
    expect(row.execution_status).toBe("running")
  })

  test("ignores events for unknown sessions", () => {
    handleSessionStatusEvent(db, registry, "unknown-sess", "idle")
    // No error thrown — just a no-op
  })

  test("ignores events for archived teams", () => {
    insertTeam(db, "t1", "my-team", "lead-sess", "archived")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "idle")

    const row = db.query("SELECT status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("busy") // unchanged
  })
})

describe("handleSessionCreatedEvent", () => {
  let tracker: DescendantTracker

  beforeEach(() => {
    tracker = new DescendantTracker()
  })

  test("tracks parent-child relationship when parentID is present", () => {
    handleSessionCreatedEvent(tracker, "child-sess", "parent-sess")
    expect(tracker.getParent("child-sess")).toBe("parent-sess")
  })

  test("does nothing when parentID is undefined", () => {
    handleSessionCreatedEvent(tracker, "child-sess", undefined)
    expect(tracker.getParent("child-sess")).toBeUndefined()
  })
})

describe("checkToolIsolation", () => {
  let registry: MemberRegistry
  let tracker: DescendantTracker

  beforeEach(() => {
    registry = new MemberRegistry()
    tracker = new DescendantTracker()
  })

  test("allows team tools for registered team members", () => {
    registry.register("t1", "alice", "sess-1")
    expect(() => checkToolIsolation(registry, tracker, "team_message", "sess-1")).not.toThrow()
  })

  test("allows team tools for lead sessions (tracked as lead in DB, not in registry)", () => {
    // Lead sessions are not in the member registry — they're the team creator.
    // checkToolIsolation should allow any session that is NOT a descendant of a team member.
    // A lead session has no parent in the tracker, so it won't be blocked.
    expect(() => checkToolIsolation(registry, tracker, "team_create", "lead-sess")).not.toThrow()
  })

  test("blocks team tools for sub-agents (descendants of team members)", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent-sess", "sess-1")

    // OQ-11: assuming throwing inside tool.execute.before fails the tool call gracefully
    expect(() => checkToolIsolation(registry, tracker, "team_message", "sub-agent-sess"))
      .toThrow("Team tools are not available to sub-agents")
  })

  test("blocks team tools for deep descendants", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("child", "sess-1")
    tracker.track("grandchild", "child")

    expect(() => checkToolIsolation(registry, tracker, "team_broadcast", "grandchild"))
      .toThrow("Team tools are not available to sub-agents")
  })

  test("allows non-team tools for any session", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent-sess", "sess-1")

    // Non-team tools (like "bash", "read", etc.) should never be blocked
    expect(() => checkToolIsolation(registry, tracker, "bash", "sub-agent-sess")).not.toThrow()
    expect(() => checkToolIsolation(registry, tracker, "read", "sub-agent-sess")).not.toThrow()
  })
})
