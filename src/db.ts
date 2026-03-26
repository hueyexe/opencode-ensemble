import { Database } from "bun:sqlite"
import path from "node:path"
import { applyMigrations } from "./schema"

let instance: Database | undefined

/**
 * Resolve the path for the ensemble SQLite database.
 * Always uses the global ~/.config/opencode/ directory, never the project directory.
 * Accepts an env override for testability.
 */
export function getDbPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? "~"
  return path.join(home, ".config", "opencode", "ensemble.db")
}

/**
 * Create and initialize a SQLite database at the given path.
 * Applies all pending migrations and enables WAL mode.
 */
export function createDb(path: string): Database {
  const db = new Database(path)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  instance = db
  return db
}

/** Get the singleton database instance. Must call createDb first. */
export function getDb(): Database {
  if (!instance) throw new Error("Database not initialized. Call createDb() first.")
  return instance
}
