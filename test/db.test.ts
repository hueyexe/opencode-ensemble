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

  test("creates project table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='project'").get()
    expect(row).toBeTruthy()
  })

  test("creates team_member table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_member'").get()
    expect(row).toBeTruthy()
  })

  test("migration 9 adds an additive last_nudged_at column to team_member, nullable, no CHECK constraint touched", () => {
    applyMigrations(db)
    const cols = db.query("PRAGMA table_info(team_member)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    const col = cols.find(c => c.name === "last_nudged_at")
    expect(col).toBeTruthy()
    expect(col?.notnull).toBe(0)
    expect(col?.dflt_value).toBeNull()

    // The status CHECK constraint must be untouched — still exactly the 5 known literals.
    const schemaRow = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_member'").get() as { sql: string }
    expect(schemaRow.sql).toContain("CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error'))")

    // Existing rows get NULL, not some default sentinel.
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'team', 'default', 'lead', 'active', 0, 0, 0)"
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, time_created, time_updated) VALUES ('t1', 'alice', 's1', 'build', 0, 0)"
    )
    const row = db.query("SELECT last_nudged_at FROM team_member WHERE name = 'alice'").get() as { last_nudged_at: number | null }
    expect(row.last_nudged_at).toBeNull()
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

  test("rejects databases from newer plugin versions", () => {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    expect(() => applyMigrations(db)).toThrow("newer than this plugin supports")
  })

  test("rolls back a failed migration without leaving half-migrated tables", () => {
    db.exec("PRAGMA foreign_keys=ON")
    db.exec(`
      CREATE TABLE team (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        lead_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        delegate INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        lead_agent TEXT
      );
      INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
        VALUES ('t1', 'old-team', 'sess-1', 'active', 0, 1, 1, NULL);
      PRAGMA user_version = 7;
    `)

    expect(() => applyMigrations(db)).toThrow()

    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(7)
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team'").get()).toBeTruthy()
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_old_m8'").get()).toBeNull()
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='project'").get()).toBeNull()
    const row = db.query("SELECT name FROM team WHERE id = 't1'").get() as { name: string }
    expect(row.name).toBe("old-team")
    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(foreignKeys.foreign_keys).toBe(1)
  })

  test("preserves disabled foreign key mode after migrations", () => {
    db.exec("PRAGMA foreign_keys=OFF")

    applyMigrations(db)

    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(foreignKeys.foreign_keys).toBe(0)
  })

  test("upgrades a version 7 database to the current project schema", () => {
    for (let i = 0; i < 7; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?, ?, ?, 'active', 0, ?, ?, ?)",
      ["t1", "legacy-team", "sess-1", 1, 2, "build"]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead) VALUES (?, ?, ?, ?, 'ready', 'idle', ?, ?, ?, ?, ?, 'none', ?, 0)",
      ["t1", "alice", "sess-a", "build", "legacy prompt", 3, 4, "/tmp/wt", "ensemble-legacy-team-alice", "ws-1"]
    )
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'medium', ?, ?)",
      ["task-1", "t1", "legacy task", 5, 6]
    )
    db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created, read) VALUES (?, ?, ?, ?, ?, 1, ?, 0)",
      ["msg-1", "t1", "alice", "lead", "legacy message", 7]
    )

    applyMigrations(db)

    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
    const project = db.query("SELECT id, name FROM project WHERE id = 'default'").get() as { id: string; name: string }
    expect(project.name).toBe("Default Project")
    const team = db.query("SELECT name, project_id, lead_agent FROM team WHERE id = 't1'").get() as { name: string; project_id: string; lead_agent: string }
    expect(team).toEqual({ name: "legacy-team", project_id: "default", lead_agent: "build" })
    const member = db.query("SELECT prompt, workspace_id, reported_to_lead FROM team_member WHERE team_id = 't1' AND name = 'alice'").get() as { prompt: string; workspace_id: string; reported_to_lead: number }
    expect(member).toEqual({ prompt: "legacy prompt", workspace_id: "ws-1", reported_to_lead: 0 })
    const task = db.query("SELECT content FROM team_task WHERE id = 'task-1'").get() as { content: string }
    expect(task.content).toBe("legacy task")
    const message = db.query("SELECT content, read FROM team_message WHERE id = 'msg-1'").get() as { content: string; read: number }
    expect(message).toEqual({ content: "legacy message", read: 0 })
  })

  test("enforces project foreign keys after migration 8", () => {
    applyMigrations(db)
    db.exec("PRAGMA foreign_keys=ON")

    expect(() =>
      db.run(
        "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'orphan', 'missing-project', 'sess1', 'active', 0, 1, 1)"
      )
    ).toThrow()
  })

  test("enforces active team name uniqueness within each project only", () => {
    applyMigrations(db)
    db.exec("PRAGMA foreign_keys=ON")
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/project-a', 'project-a', '/tmp/project-a', 'active', 1, 1)")
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/project-b', 'project-b', '/tmp/project-b', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'same-name', '/tmp/project-a', 'sess1', 'active', 0, 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'same-name', '/tmp/project-b', 'sess2', 'active', 0, 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t3', 'same-name', '/tmp/project-a', 'sess3', 'archived', 0, 1, 1)")

    expect(() =>
      db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t4', 'same-name', '/tmp/project-a', 'sess4', 'active', 0, 1, 1)")
    ).toThrow()
  })

  test("can insert and query a team", () => {
    applyMigrations(db)
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/test-project", "test-project", "/tmp/test-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "/tmp/test-project", "sess1", "active", 0, Date.now(), Date.now()]
    )
    const row = db.query("SELECT * FROM team WHERE id = ?").get("t1") as Record<string, unknown>
    expect(row.name).toBe("my-team")
    expect(row.status).toBe("active")
  })

  test("can insert and query a team_member", () => {
    applyMigrations(db)
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/test-project", "test-project", "/tmp/test-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "/tmp/test-project", "sess1", "active", 0, Date.now(), Date.now()]
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

    freshDb.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/test-project', 'test-project', '/tmp/test-project', 'active', 1, 1)")
    freshDb.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'test', '/tmp/test-project', 'sess-1', 'active', 0, 1, 1)")
    freshDb.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'ready', 'idle', 1, 1)")

    const row = freshDb.query("SELECT workspace_id FROM team_member WHERE name = 'alice'").get() as { workspace_id: string | null }
    expect(row.workspace_id).toBeNull()
    freshDb.close()
  })

  test("team_member cascade deletes when team is deleted", () => {
    applyMigrations(db)
    db.run("PRAGMA foreign_keys = ON")
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/test-project", "test-project", "/tmp/test-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "/tmp/test-project", "sess1", "active", 0, Date.now(), Date.now()]
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
