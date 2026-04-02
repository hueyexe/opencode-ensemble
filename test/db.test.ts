import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations, MIGRATIONS } from "../src/schema"
import { createDb, getDb, getDbPath } from "../src/db"
import path from "path"

describe("schema migrations", () => {
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
    db.exec("PRAGMA journal_mode=WAL")
  })

  test("applies all migrations to a fresh database", () => {
    applyMigrations(db)
    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
  })

  test("creates team table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team'").get()
    expect(row).toBeTruthy()
  })

  test("creates team_member table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_member'").get()
    expect(row).toBeTruthy()
  })

  test("creates team_task table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_task'").get()
    expect(row).toBeTruthy()
  })

  test("creates team_message table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_message'").get()
    expect(row).toBeTruthy()
  })

  test("is idempotent — running twice does not error", () => {
    applyMigrations(db)
    applyMigrations(db)
    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
  })

  test("can insert and query a team", () => {
    applyMigrations(db)
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "sess1", "active", 0, Date.now(), Date.now()]
    )
    const row = db.query("SELECT * FROM team WHERE id = ?").get("t1") as Record<string, unknown>
    expect(row.name).toBe("my-team")
    expect(row.status).toBe("active")
  })

  test("can insert and query a team_member", () => {
    applyMigrations(db)
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "sess1", "active", 0, Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "alice", "sess2", "build", "ready", "idle", Date.now(), Date.now()]
    )
    const row = db.query("SELECT * FROM team_member WHERE name = ?").get("alice") as Record<string, unknown>
    expect(row.agent).toBe("build")
    expect(row.status).toBe("ready")
  })

  test("migration 6 adds workspace_id column to team_member", () => {
    const freshDb = new Database(":memory:")
    freshDb.exec("PRAGMA journal_mode=WAL")
    freshDb.exec("PRAGMA foreign_keys=ON")
    applyMigrations(freshDb)

    freshDb.run("INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'test', 'sess-1', 'active', 0, 1, 1)")
    freshDb.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'ready', 'idle', 1, 1)")

    const row = freshDb.query("SELECT workspace_id FROM team_member WHERE name = 'alice'").get() as { workspace_id: string | null }
    expect(row.workspace_id).toBeNull()
    freshDb.close()
  })

  test("team_member cascade deletes when team is deleted", () => {
    applyMigrations(db)
    db.run("PRAGMA foreign_keys = ON")
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "sess1", "active", 0, Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "alice", "sess2", "build", "ready", "idle", Date.now(), Date.now()]
    )
    db.run("DELETE FROM team WHERE id = ?", ["t1"])
    const row = db.query("SELECT * FROM team_member WHERE team_id = ?").get("t1")
    expect(row).toBeNull()
  })
})

describe("createDb", () => {
  test("returns a database with migrations applied", () => {
    const db = createDb(":memory:")
    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
  })

  test("WAL mode is enabled", () => {
    const tmpPath = `/tmp/ensemble-test-${Date.now()}.db`
    const db = createDb(tmpPath)
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(mode.journal_mode).toBe("wal")
    db.close()
    // cleanup
    try { require("fs").unlinkSync(tmpPath) } catch {}
    try { require("fs").unlinkSync(tmpPath + "-wal") } catch {}
    try { require("fs").unlinkSync(tmpPath + "-shm") } catch {}
  })
})

describe("getDbPath", () => {
  test("resolves to ~/.config/opencode/ensemble.db using HOME", () => {
    const result = getDbPath({ HOME: "/home/testuser", USERPROFILE: undefined })
    expect(result).toBe(path.join("/home/testuser", ".config", "opencode", "ensemble.db"))
  })

  test("falls back to USERPROFILE when HOME is not set", () => {
    const result = getDbPath({ HOME: undefined, USERPROFILE: "C:\\Users\\testuser" })
    expect(result).toBe(path.join("C:\\Users\\testuser", ".config", "opencode", "ensemble.db"))
  })

  test("falls back to ~ when neither HOME nor USERPROFILE is set", () => {
    const result = getDbPath({ HOME: undefined, USERPROFILE: undefined })
    expect(result).toBe(path.join("~", ".config", "opencode", "ensemble.db"))
  })

  test("never includes the project directory in the path", () => {
    const result = getDbPath({ HOME: "/home/testuser", USERPROFILE: undefined })
    expect(result).not.toContain(".opencode/ensemble.db")
    expect(result).toContain(path.join(".config", "opencode", "ensemble.db"))
  })
})
