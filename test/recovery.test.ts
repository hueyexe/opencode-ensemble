import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMigrations } from "../src/schema"
import { recoverStaleMembers, recoverUndeliveredMessages, rehydrateRegistry, recoverOrphanedTeams, isSessionAlive } from "../src/recovery"
import type { PluginClient } from "../src/types"
import { MemberRegistry } from "../src/state"
import { sendMessage, broadcastMessage } from "../src/messaging"

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} exited with code ${exit}`)
  return stdout
}

function setupDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  return db
}

function insertTeam(db: Database, id: string, name: string, leadSession: string) {
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    [id, name, leadSession, Date.now(), Date.now()]
  )
}

function insertMember(db: Database, teamId: string, name: string, sessionId: string, status: string, execStatus: string) {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', ?, ?, ?, ?)",
    [teamId, name, sessionId, status, execStatus, Date.now(), Date.now()]
  )
}

function mockClient(): PluginClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  return {
    calls,
    session: {
      async create(options) { calls.push({ method: "session.create", args: [options] }); return { data: { id: "mock" } } },
      async promptAsync(options) { calls.push({ method: "session.promptAsync", args: [options] }); return {} },
      async abort(options) { calls.push({ method: "session.abort", args: [options] }); return {} },
      async status() { calls.push({ method: "session.status", args: [] }); return { data: {} } },
      async messages(options) { calls.push({ method: "session.messages", args: [options] }); return { data: [] } },
      async get(options) { calls.push({ method: "session.get", args: [options] }); return { data: {} } },
    },
    tui: {
      async showToast(options) { calls.push({ method: "tui.showToast", args: [options] }); return {} },
      async selectSession(options) { calls.push({ method: "tui.selectSession", args: [options] }); return {} },
    },
    worktree: {
      async create(options) { calls.push({ method: "worktree.create", args: [options] }); return { data: { name: "default", branch: "ensemble-default", directory: "/tmp/wt" } } },
      async remove(options) { calls.push({ method: "worktree.remove", args: [options] }); return {} },
      async list() { calls.push({ method: "worktree.list", args: [] }); return { data: [] } },
      async reset(options) { calls.push({ method: "worktree.reset", args: [options] }); return {} },
    },
    workspace: {
      async create(options) { calls.push({ method: "workspace.create", args: [options] }); return { data: { id: "ws-1", type: "worktree", branch: null, directory: null, projectID: "proj-1" } } },
      async remove(options) { calls.push({ method: "workspace.remove", args: [options] }); return {} },
      async list() { calls.push({ method: "workspace.list", args: [] }); return { data: [] } },
    },
  }
}

describe("isSessionAlive", () => {
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    client = mockClient()
  })

  test("returns true when session.get resolves", async () => {
    client.session.get = async () => ({ data: {} })
    expect(await isSessionAlive(client, "sess-1", 50)).toBe(true)
  })

  test("returns false when session.get throws", async () => {
    client.session.get = async () => { throw new Error("session not found") }
    expect(await isSessionAlive(client, "sess-1", 50)).toBe(false)
  })

  // Regression: a session.get() call made from within this plugin's own init
  // sequence, before the server has finished bootstrapping, was confirmed to
  // hang indefinitely rather than resolve or reject -- a self-referential
  // HTTP-call deadlock, the same class team-spawn.ts's withTimeout already
  // guards against for worktree.create/session.create. Live-reproduced
  // 2026-08-17: a real server never responded to ANY request (including
  // unrelated ones) when a stale team from a prior run existed for the
  // project. isSessionAlive must resolve within its bound regardless of
  // whether the underlying call ever settles, and must treat "we genuinely
  // don't know" as alive (don't archive on an inconclusive check) rather than
  // as dead.
  test("resolves within the timeout bound instead of hanging when session.get never settles", async () => {
    client.session.get = () => new Promise(() => { /* never resolves or rejects */ })
    const start = Date.now()
    const result = await isSessionAlive(client, "sess-1", 50)
    expect(Date.now() - start).toBeLessThan(1000)
    expect(result).toBe(true)
  })
})

describe("recoverOrphanedTeams", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
  })

  test("archives an active team whose lead session no longer exists", async () => {
    insertTeam(db, "t1", "dead-team", "dead-lead-sess")
    client.session.get = async (options) => {
      if (options.sessionID === "dead-lead-sess") throw new Error("session not found")
      return { data: {} }
    }

    const result = await recoverOrphanedTeams(db, client)
    expect(result.archived).toBe(1)

    const row = db.query("SELECT status FROM team WHERE id = ?").get("t1") as { status: string }
    expect(row.status).toBe("archived")
  })

  test("leaves an active team alone when its lead session is genuinely alive", async () => {
    insertTeam(db, "t1", "live-team", "live-lead-sess")
    // Default mock client.session.get always resolves.

    const result = await recoverOrphanedTeams(db, client)
    expect(result.archived).toBe(0)

    const row = db.query("SELECT status FROM team WHERE id = ?").get("t1") as { status: string }
    expect(row.status).toBe("active")
  })

  test("does not touch teams already archived", async () => {
    insertTeam(db, "t1", "old-team", "dead-lead-sess")
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    client.session.get = async () => { throw new Error("session not found") }

    const result = await recoverOrphanedTeams(db, client)
    expect(result.archived).toBe(0)
  })

  test("unregisters an archived team from the in-memory registry", async () => {
    insertTeam(db, "t1", "dead-team", "dead-lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    client.session.get = async (options) => {
      if (options.sessionID === "dead-lead-sess") throw new Error("session not found")
      return { data: {} }
    }
    const registry = new MemberRegistry()
    registry.register("t1", "alice", "sess-1")

    await recoverOrphanedTeams(db, client, undefined, registry)

    expect(registry.getBySession("sess-1")).toBeUndefined()
  })

  test("scopes to the given project when cwd is provided", async () => {
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/other-project", "other-project", "/tmp/other-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)",
      ["t2", "other-team", "/tmp/other-project", "dead-lead-sess-2", Date.now(), Date.now()]
    )
    client.session.get = async () => { throw new Error("session not found") }

    const result = await recoverOrphanedTeams(db, client, "/tmp/other-project")
    expect(result.archived).toBe(1)

    const row = db.query("SELECT status FROM team WHERE id = ?").get("t2") as { status: string }
    expect(row.status).toBe("archived")
  })
})

describe("recoverStaleMembers", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
  })

  test("marks busy members as error on recovery", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    insertMember(db, "t1", "bob", "sess-2", "busy", "running")

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(2)

    const alice = db.query("SELECT status, execution_status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("error")
    expect(alice.execution_status).toBe("idle")

    const bob = db.query("SELECT status, execution_status FROM team_member WHERE name = ?").get("bob") as Record<string, string>
    expect(bob.status).toBe("error")
    expect(bob.execution_status).toBe("idle")
  })

  test("aborts orphaned sessions during recovery", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    insertMember(db, "t1", "bob", "sess-2", "busy", "running")

    await recoverStaleMembers(db, client)

    const abortCalls = client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(2)
  })

  test("releases in_progress tasks of stale members back to the pool", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task_a', 't1', 'work', 'in_progress', 'medium', 'alice', ?, ?)",
      [Date.now(), Date.now()]
    )

    await recoverStaleMembers(db, client)

    const row = db.query("SELECT status, assignee FROM team_task WHERE id = 'task_a'").get() as { status: string; assignee: string | null }
    expect(row.status).toBe("pending")
    expect(row.assignee).toBeNull()
  })

  test("continues recovery even if abort fails", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    insertMember(db, "t1", "bob", "sess-2", "busy", "running")
    client.session.abort = async () => { throw new Error("abort failed") }

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(2)

    // Both should still be marked error despite abort failures
    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    const bob = db.query("SELECT status FROM team_member WHERE name = ?").get("bob") as Record<string, string>
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("error")
  })

  // Regression: client.session.abort() is the same self-referential-HTTP-call
  // shape as isSessionAlive()'s client.session.get() (recoverOrphanedTeams'
  // deadlock, fixed 2026-08-17) -- a call back to this same server, made
  // synchronously from within plugin init before the server has finished
  // bootstrapping. recoverStaleMembers is awaited synchronously in index.ts
  // (unlike recoverOrphanedTeams, which is now fire-and-forget) specifically
  // because rehydrateRegistry depends on it completing first -- so the fix
  // here is a bounded timeout on the abort call itself, not fire-and-forget.
  // Confirmed via source review this is a live latent bug, not exercised by
  // any test data so far only because it requires a genuinely 'busy' member
  // at restart time, a query-filter coincidence rather than a structural
  // guard against the underlying deadlock class.
  test("does not hang forever if session.abort never settles", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    client.session.abort = () => new Promise(() => { /* never resolves or rejects */ })

    const start = Date.now()
    const result = await recoverStaleMembers(db, client, undefined, 50)
    expect(Date.now() - start).toBeLessThan(1000)

    // The DB-only work (marking busy members as error) must still have
    // completed and be reflected in the returned count, independent of
    // whether the network-side abort ever settles.
    expect(result.interrupted).toBe(1)
    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("error")
  })

  test("does not touch non-busy members", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "ready", "idle")
    insertMember(db, "t1", "bob", "sess-2", "shutdown", "idle")

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("ready")

    // No abort calls
    const abortCalls = client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(0)
  })

  test("returns zero when no stale state exists", async () => {
    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)
  })

  test("is idempotent — running twice produces same result", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")

    await recoverStaleMembers(db, client)
    const result2 = await recoverStaleMembers(db, client)
    expect(result2.interrupted).toBe(0)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("error")
  })

  test("only recovers members in active teams", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)
  })

  test("only recovers stale members for the current project when provided", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-a", "t1"])
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")

    insertTeam(db, "t2", "other-team", "other-lead")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-b", "t2"])
    insertMember(db, "t2", "bob", "sess-2", "busy", "running")

    const result = await recoverStaleMembers(db, client, "/tmp/project-a")
    expect(result.interrupted).toBe(1)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as { status: string }
    const bob = db.query("SELECT status FROM team_member WHERE name = ?").get("bob") as { status: string }
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("busy")

    const abortCalls = client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    expect((abortCalls[0]!.args[0] as { sessionID: string }).sessionID).toBe("sess-1")
  })

  test("recovers legacy default-project members when current project is provided", async () => {
    insertTeam(db, "legacy", "legacy-team", "legacy-lead")
    insertMember(db, "legacy", "alice", "sess-legacy", "busy", "running")

    insertTeam(db, "current", "current-team", "current-lead")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-a", "current"])
    insertMember(db, "current", "bob", "sess-current", "busy", "running")

    insertTeam(db, "other", "other-team", "other-lead")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-b", "other"])
    insertMember(db, "other", "cara", "sess-other", "busy", "running")

    const result = await recoverStaleMembers(db, client, "/tmp/project-a")
    expect(result.interrupted).toBe(2)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as { status: string }
    const bob = db.query("SELECT status FROM team_member WHERE name = ?").get("bob") as { status: string }
    const cara = db.query("SELECT status FROM team_member WHERE name = ?").get("cara") as { status: string }
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("error")
    expect(cara.status).toBe("busy")
  })
})

describe("recoverUndeliveredMessages", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    registry = new MemberRegistry()
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-alice")
    insertMember(db, "t1", "bob", "sess-bob")
    registry.register("t1", "alice", "sess-alice")
    registry.register("t1", "bob", "sess-bob")
  })

  function insertMember(db: Database, teamId: string, name: string, sessionId: string) {
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      [teamId, name, sessionId, Date.now(), Date.now()]
    )
  }

  test("redelivers undelivered direct messages via promptAsync", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(1)

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)

    // Message should now be marked delivered
    const msgs = db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(msgs[0]!.delivered).toBe(1)
  })

  test("skips lead-bound messages (delivered via system prompt transform instead)", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "lead", content: "done" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)

    // No promptAsync calls for lead messages
    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)
  })

  test("redelivers on the recipient's configured model when set", async () => {
    db.run("UPDATE team_member SET model = 'anthropic/claude-sonnet' WHERE team_id = 't1' AND name = 'bob'")
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })

    await recoverUndeliveredMessages(db, client, registry)

    const promptCall = client.calls.find(c => c.method === "session.promptAsync")
    const opts = promptCall!.args[0] as { model?: { providerID: string; modelID: string } }
    expect(opts.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
  })

  test("redelivers without a model when the recipient has none set", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })

    await recoverUndeliveredMessages(db, client, registry)

    const promptCall = client.calls.find(c => c.method === "session.promptAsync")
    const opts = promptCall!.args[0] as { model?: unknown }
    expect(opts.model).toBeUndefined()
  })

  test("skips already-delivered messages", async () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    db.run("UPDATE team_message SET delivered = 1 WHERE id = ?", [id])

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)
  })

  test("returns zero when no undelivered messages", async () => {
    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)
  })

  test("handles multiple undelivered messages (skips lead-bound)", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    sendMessage(db, { teamId: "t1", from: "bob", to: "alice", content: "msg2" })
    sendMessage(db, { teamId: "t1", from: "alice", to: "lead", content: "msg3" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(2) // only member-to-member, not lead

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(2)
  })

  test("continues on partial failure", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg2" })

    // Make first promptAsync fail
    let callCount = 0
    client.session.promptAsync = async (options) => {
      callCount++
      if (callCount === 1) throw new Error("network error")
      return {}
    }

    const result = await recoverUndeliveredMessages(db, client, registry)
    // One succeeded, one failed
    expect(result.redelivered).toBe(1)
  })

  test("skips broadcast messages (to_name is NULL)", async () => {
    broadcastMessage(db, { teamId: "t1", from: "alice", content: "hey everyone" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)

    // No promptAsync calls should have been made
    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    // Message should remain undelivered
    const msgs = db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(msgs[0]!.delivered).toBe(0)
  })

  test("skips messages to unknown recipients not in registry", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "charlie", content: "hello" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)
  })

  test("returns zero when no active teams exist", async () => {
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)
  })

  test("recovers member-to-member messages across multiple active teams (skips lead-bound)", async () => {
    // Set up a second team
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
      ["t2", "team-two", "lead-sess-2", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      ["t2", "charlie", "sess-charlie", Date.now(), Date.now()]
    )
    registry.register("t2", "charlie", "sess-charlie")

    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg for t1" })
    sendMessage(db, { teamId: "t2", from: "charlie", to: "lead", content: "msg for t2" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(1) // only member-to-member, lead-bound skipped

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })
})

describe("recoverOrphanedBranches", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
  })

  test("only deletes preserved branches for archived teams in the current project", async () => {
    insertTeam(db, "t1", "alpha", "lead-a")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
    db.run("UPDATE team SET status = 'archived', project_id = ? WHERE id = ?", ["/tmp/project-a", "t1"])

    insertTeam(db, "t2", "beta", "lead-b")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
    db.run("UPDATE team SET status = 'archived', project_id = ? WHERE id = ?", ["/tmp/project-b", "t2"])

    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-branches-"))
    try {
      db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-a', ?, 'active', ?, ?)", [repo, repo, Date.now(), Date.now()])
      db.run("UPDATE team SET project_id = ? WHERE id = ?", [repo, "t1"])
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "test@example.com"])
      await git(repo, ["config", "user.name", "Test User"])
      await git(repo, ["commit", "--allow-empty", "-m", "init"])
      await git(repo, ["branch", "ensemble/preserved/project-a/alpha#t1/alice"])
      await git(repo, ["branch", "ensemble/preserved/alpha/legacy-alice"])
      await git(repo, ["branch", "ensemble/preserved/project-b/beta#t2/bob"])

      const { recoverOrphanedBranches } = await import("../src/recovery")
      const result = await recoverOrphanedBranches(db, repo)
      const remaining = await git(repo, ["branch", "--list", "ensemble/preserved/*", "--format", "%(refname:short)"])

      expect(result.removed).toBe(2)
      expect(remaining.trim()).toBe("ensemble/preserved/project-b/beta#t2/bob")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("recoverOrphanedWorktrees", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("removes orphaned ensemble worktrees not in active teams", async () => {
    // Mock worktree.list returns a worktree that has no matching active member
    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "ensemble-old-team-alice", branch: "ensemble-old-team-alice", directory: "/tmp/wt-orphan" },
      ] }
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(1)

    const removeCalls = client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)
  })

  test("does not remove worktrees belonging to active members", async () => {
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
    db.run("UPDATE team_member SET worktree_dir = ? WHERE name = 'alice'", ["/tmp/wt-alice"])

    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "ensemble-my-team-alice", branch: "ensemble-my-team-alice", directory: "/tmp/wt-alice" },
      ] }
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(0)
  })

  test("ignores non-ensemble worktrees", async () => {
    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "user-feature-branch", branch: "feature-branch", directory: "/tmp/wt-user" },
      ] }
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(0)
  })

  test("returns zero when worktree.list fails", async () => {
    client.worktree.list = async () => { throw new Error("not supported") }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(0)
  })

  test("continues if individual worktree removal fails", async () => {
    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "ensemble-old-a", branch: "ensemble-old-a", directory: "/tmp/wt-a" },
        { name: "ensemble-old-b", branch: "ensemble-old-b", directory: "/tmp/wt-b" },
      ] }
    }
    let removeCount = 0
    client.worktree.remove = async () => {
      removeCount++
      if (removeCount === 1) throw new Error("failed")
      return {}
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(1) // second one succeeded
  })
})

describe("rehydrateRegistry", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("rehydrates an idle (ready) member from SQLite — the desktop bug", () => {
    // This is the exact scenario from the production bug:
    // a teammate exists in SQLite at status='ready' from a previous plugin
    // lifetime, the plugin restarts, the registry is empty. Without
    // rehydration, the teammate's team_* tool calls fail with "This
    // session is not in a team."
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    const entry = registry.getBySession("scout-sess")
    expect(entry?.memberName).toBe("scout")
    expect(entry?.teamId).toBe("t1")
  })

  test("rehydrates a busy member (not just ready ones)", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    expect(registry.getBySession("scout-sess")?.memberName).toBe("scout")
  })

  test("skips members in terminal states (shutdown, error)", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "shutdown", "completed")
    insertMember(db, "t1", "bob", "bob-sess", "error", "failed")
    insertMember(db, "t1", "carol", "carol-sess", "ready", "idle")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    expect(registry.getBySession("alice-sess")).toBeUndefined()
    expect(registry.getBySession("bob-sess")).toBeUndefined()
    expect(registry.getBySession("carol-sess")?.memberName).toBe("carol")
  })

  test("skips members in archived teams", () => {
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'archived', 0, ?, ?)",
      ["t1", "old", "lead-sess", Date.now(), Date.now()]
    )
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(0)
    expect(registry.getBySession("scout-sess")).toBeUndefined()
  })

  test("returns 0 when no active teams exist", () => {
    expect(rehydrateRegistry(db, registry)).toBe(0)
  })

  test("rehydrates members from multiple active teams", () => {
    insertTeam(db, "t1", "alpha", "lead-1")
    insertTeam(db, "t2", "beta", "lead-2")
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")
    insertMember(db, "t2", "ranger", "ranger-sess", "busy", "running")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(2)
    expect(registry.getBySession("scout-sess")?.teamId).toBe("t1")
    expect(registry.getBySession("ranger-sess")?.teamId).toBe("t2")
  })

  test("is idempotent — running twice does not duplicate or error", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")

    rehydrateRegistry(db, registry)
    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    expect(registry.getBySession("scout-sess")?.memberName).toBe("scout")
  })
})
