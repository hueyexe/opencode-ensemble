import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations, MIGRATIONS } from "../src/schema"
import { createDb, getDb } from "../src/db"

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
