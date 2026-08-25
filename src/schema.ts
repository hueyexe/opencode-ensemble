import type { Database } from "./db"

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
  // Migration 5: Track lead's agent mode so message delivery preserves it
  `ALTER TABLE team ADD COLUMN lead_agent TEXT;`,
  // Migration 6: Track workspace ID for worktree-session binding
  `ALTER TABLE team_member ADD COLUMN workspace_id TEXT;`,
  // Migration 7: Track whether teammate has reported to lead (completion loop prevention, issue #3)
  `ALTER TABLE team_member ADD COLUMN reported_to_lead INTEGER NOT NULL DEFAULT 0;`,
  // Migration 8: Add project as the dashboard grouping level. For this initial
  // project-first step, project_id is the team lead's working directory.
  `PRAGMA foreign_keys=OFF;
   ALTER TABLE team RENAME TO team_old_m8;
   CREATE TABLE IF NOT EXISTS project (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     path            TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL
   );
   INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated)
     VALUES ('default', 'Default Project', '', 'active', strftime('%s','now') * 1000, strftime('%s','now') * 1000);
   CREATE TABLE team (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     project_id      TEXT NOT NULL DEFAULT 'default' REFERENCES project(id) ON DELETE CASCADE,
     lead_session_id TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     delegate        INTEGER NOT NULL DEFAULT 0,
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL,
     lead_agent      TEXT
   );
   INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     SELECT id, name, 'default', lead_session_id, status, delegate, time_created, time_updated, lead_agent FROM team_old_m8;
   DROP TABLE team_old_m8;

   ALTER TABLE team_member RENAME TO team_member_old_m8;
   CREATE TABLE team_member (
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
     worktree_dir     TEXT,
     worktree_branch  TEXT,
     plan_approval    TEXT NOT NULL DEFAULT 'none'
                        CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected')),
     workspace_id     TEXT,
     reported_to_lead INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (team_id, name)
   );
   INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead)
     SELECT team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead FROM team_member_old_m8;
   DROP TABLE team_member_old_m8;

   ALTER TABLE team_task RENAME TO team_task_old_m8;
   CREATE TABLE team_task (
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
   INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated)
     SELECT id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated FROM team_task_old_m8;
   DROP TABLE team_task_old_m8;

   ALTER TABLE team_message RENAME TO team_message_old_m8;
   CREATE TABLE team_message (
     id            TEXT PRIMARY KEY,
     team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     from_name     TEXT NOT NULL,
     to_name       TEXT,
     content       TEXT NOT NULL,
     delivered     INTEGER NOT NULL DEFAULT 0,
     time_created  INTEGER NOT NULL,
     read          INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created, read)
     SELECT id, team_id, from_name, to_name, content, delivered, time_created, read FROM team_message_old_m8;
   DROP TABLE team_message_old_m8;

   CREATE INDEX IF NOT EXISTS team_lead_idx ON team(lead_session_id);
   CREATE INDEX IF NOT EXISTS team_status_idx ON team(status);
   CREATE INDEX IF NOT EXISTS team_project_idx ON team(project_id, status);
   CREATE UNIQUE INDEX IF NOT EXISTS team_active_project_name_idx ON team(project_id, name) WHERE status = 'active';
   CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
   CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);
   CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
   CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
   CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);
   CREATE INDEX IF NOT EXISTS team_message_team_idx ON team_message(team_id);
   CREATE INDEX IF NOT EXISTS team_message_to_idx ON team_message(to_name);
   CREATE INDEX IF NOT EXISTS team_message_undelivered_idx ON team_message(team_id, delivered) WHERE delivered = 0;
   CREATE INDEX IF NOT EXISTS team_message_unread_idx ON team_message(team_id, read) WHERE read = 0;
   PRAGMA foreign_keys=ON;`,
  // Migration 9: Add last_nudged_at to team_member — additive-only display-staleness
  // signal for the watchdog's soft stall-nudge path. Deliberately NOT a new status
  // enum value (see checkStalled() in watchdog.ts for the rationale): a 6th CHECK
  // constraint literal would require a table-rebuild migration and touch every
  // consumer that switches on the 5 known status strings. This column is additive —
  // existing consumers that don't know about it simply don't render it.
  `ALTER TABLE team_member ADD COLUMN last_nudged_at INTEGER;`,
  // Migration 10: Add retry_* columns to team_member — additive-only provider-retry
  // display signal (see hooks.ts's "retry" branch). Same non-negotiable as Migration
  // 9: no 6th status/execution_status literal, no table rebuild. retry_until is a
  // TTL, not a stored enum — "currently retrying" is derived at read time
  // (retry_until > Date.now()), so there is no explicit clear-write anywhere in this
  // fix; it simply becomes stale and gets superseded by real activity or by time
  // elapsing.
  `ALTER TABLE team_member ADD COLUMN retry_until INTEGER;
   ALTER TABLE team_member ADD COLUMN retry_attempt INTEGER;
   ALTER TABLE team_member ADD COLUMN retry_provider TEXT;
   ALTER TABLE team_member ADD COLUMN retry_message TEXT;`,
]

/**
 * Apply pending migrations to the database.
 * Uses PRAGMA user_version to track which migrations have been applied.
 */
export function applyMigrations(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number }

  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this plugin supports (${MIGRATIONS.length}). Upgrade opencode-ensemble before continuing.`)
  }

  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]
    const { foreign_keys: foreignKeys } = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }

    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      if (migration) db.exec(migration)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    } finally {
      db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`)
    }
  }
}
