import type { Database } from "bun:sqlite"

/** Migration SQL statements, applied in order. Version = index + 1. */
export const MIGRATIONS: string[] = [
  // Migration 1: Initial schema — 4 tables
  `
  CREATE TABLE IF NOT EXISTS team (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    lead_session_id TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    delegate        INTEGER NOT NULL DEFAULT 0,
    time_created    INTEGER NOT NULL,
    time_updated    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_lead_idx ON team(lead_session_id);
  CREATE INDEX IF NOT EXISTS team_status_idx ON team(status);

  CREATE TABLE IF NOT EXISTS team_member (
    team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    agent            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'ready'
                       CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error')),
    execution_status TEXT NOT NULL DEFAULT 'idle'
                       CHECK(execution_status IN ('idle', 'starting', 'running',
                         'cancel_requested', 'cancelling', 'cancelled',
                         'completing', 'completed', 'failed', 'timed_out')),
    model            TEXT,
    prompt           TEXT,
    time_created     INTEGER NOT NULL,
    time_updated     INTEGER NOT NULL,
    PRIMARY KEY (team_id, name)
  );
  CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
  CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);

  CREATE TABLE IF NOT EXISTS team_task (
    id            TEXT PRIMARY KEY,
    team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked')),
    priority      TEXT NOT NULL DEFAULT 'medium'
                    CHECK(priority IN ('high', 'medium', 'low')),
    assignee      TEXT,
    depends_on    TEXT,
    time_created  INTEGER NOT NULL,
    time_updated  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
  CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
  CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);

  CREATE TABLE IF NOT EXISTS team_message (
    id            TEXT PRIMARY KEY,
    team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    from_name     TEXT NOT NULL,
    to_name       TEXT,
    content       TEXT NOT NULL,
    delivered     INTEGER NOT NULL DEFAULT 0,
    time_created  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_message_team_idx ON team_message(team_id);
  CREATE INDEX IF NOT EXISTS team_message_to_idx ON team_message(to_name);
  CREATE INDEX IF NOT EXISTS team_message_undelivered_idx ON team_message(team_id, delivered)
    WHERE delivered = 0;
  `,
  // Migration 2: Add read column to team_message for team_results tracking
  `ALTER TABLE team_message ADD COLUMN read INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS team_message_unread_idx ON team_message(team_id, read) WHERE read = 0;`,
  // Migration 3: Add worktree columns to team_member for git worktree isolation
  `ALTER TABLE team_member ADD COLUMN worktree_dir TEXT;
   ALTER TABLE team_member ADD COLUMN worktree_branch TEXT;`,
  // Migration 4: Add plan_approval column to team_member for plan-before-build workflow
  `ALTER TABLE team_member ADD COLUMN plan_approval TEXT NOT NULL DEFAULT 'none'
     CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected'));`,
]

/**
 * Apply pending migrations to the database.
 * Uses PRAGMA user_version to track which migrations have been applied.
 */
export function applyMigrations(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number }

  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]!)
    db.exec(`PRAGMA user_version = ${i + 1}`)
  }
}
