import { createRequire } from "node:module"
import path from "node:path"
import { applyMigrations } from "./schema"

interface SqliteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

interface SqliteRunResult {
  changes: number
}

/** Minimal synchronous SQLite database interface used by Ensemble. */
export interface Database {
  exec(sql: string): void
  query(sql: string): SqliteStatement
  run(sql: string, ...params: unknown[]): SqliteRunResult
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult
  close(): void
}

interface BunSqliteModule {
  Database: new (filename: string) => Database
}

interface NodeSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => NodeSqliteDatabase
}

const requireRuntimeModule = createRequire(import.meta.url)

let instance: Database | undefined

class NodeSqliteAdapter implements Database {
  private readonly db: NodeSqliteDatabase

  constructor(filename: string) {
    const sqlite = requireRuntimeModule(["node", "sqlite"].join(":")) as NodeSqliteModule
    this.db = new sqlite.DatabaseSync(filename)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  query(sql: string): SqliteStatement {
    return this.db.prepare(sql)
  }

  run(sql: string, ...params: unknown[]): SqliteRunResult {
    const bindings = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
    return this.db.prepare(sql).run(...bindings) as SqliteRunResult
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      this.exec("BEGIN")
      try {
        const result = fn(...args)
        this.exec("COMMIT")
        return result
      } catch (err) {
        this.exec("ROLLBACK")
        throw err
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

function openDatabase(filename: string): Database {
  if (typeof process.versions.bun === "string") {
    const sqlite = requireRuntimeModule(["bun", "sqlite"].join(":")) as BunSqliteModule
    return new sqlite.Database(filename)
  }

  return new NodeSqliteAdapter(filename)
}

/**
 * Resolve the path for the global ensemble SQLite database.
 * Project data is logically isolated by project_id inside this DB.
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
  const db = openDatabase(path)
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
