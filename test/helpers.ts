import { Database } from "bun:sqlite"
import { applyMigrations } from "../src/schema"
import { MemberRegistry, DescendantTracker } from "../src/state"
import type { ToolDeps, PluginClient } from "../src/types"

/** Create a fresh in-memory DB with migrations applied. */
export function setupDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  return db
}

/** Create a mock PluginClient that records all calls. */
export function mockClient(): PluginClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  return {
    calls,
    session: {
      async create(options) {
        calls.push({ method: "session.create", args: [options] })
        return { data: { id: `mock-sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } }
      },
      async promptAsync(options) {
        calls.push({ method: "session.promptAsync", args: [options] })
        return {}
      },
      async abort(options) {
        calls.push({ method: "session.abort", args: [options] })
        return {}
      },
      async status() {
        calls.push({ method: "session.status", args: [] })
        return { data: {} }
      },
    },
    tui: {
      async showToast(options) {
        calls.push({ method: "tui.showToast", args: [options] })
        return {}
      },
      async selectSession(options) {
        calls.push({ method: "tui.selectSession", args: [options] })
        return {}
      },
    },
  }
}

/** Create full ToolDeps for testing. */
export function setupDeps(db?: Database): ToolDeps & { client: ReturnType<typeof mockClient> } {
  const d = db ?? setupDb()
  return {
    db: d,
    registry: new MemberRegistry(),
    tracker: new DescendantTracker(),
    client: mockClient(),
  }
}

/** Insert a team directly into the DB. */
export function insertTeam(db: Database, id: string, name: string, leadSession: string, status = "active") {
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [id, name, leadSession, status, Date.now(), Date.now()]
  )
}

/** Insert a member directly into the DB. */
export function insertMember(db: Database, teamId: string, name: string, sessionId: string, status = "ready", execStatus = "idle") {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', ?, ?, ?, ?)",
    [teamId, name, sessionId, status, execStatus, Date.now(), Date.now()]
  )
}
