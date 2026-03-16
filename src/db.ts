import { Database } from "bun:sqlite"
import { applyMigrations } from "./schema"

let instance: Database | undefined

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
