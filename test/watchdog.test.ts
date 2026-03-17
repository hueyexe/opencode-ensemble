import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { Watchdog } from "../src/watchdog"

describe("Watchdog", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("times out a member that has been busy longer than TTL", async () => {
    // Insert member with time_updated far in the past
    const pastTime = Date.now() - 60_000 // 60s ago
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.registry.register("t1", "alice", "sess-a")

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    // Member should be timed_out
    const row = deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("error")
    expect(row.execution_status).toBe("timed_out")

    // Session should have been aborted
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)

    // Toast should have been fired
    const toastCalls = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toastCalls).toHaveLength(1)
    const msg = (toastCalls[0]!.args[0] as Record<string, unknown>).message as string
    expect(msg).toContain("alice")
    expect(msg).toContain("timed out")
  })

  test("does not time out a member within TTL", async () => {
    // Insert member with recent time_updated
    const now = Date.now()
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", now, now]
    )
    deps.registry.register("t1", "alice", "sess-a")

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("busy")
  })

  test("does not time out non-busy members", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("ready")
  })

  test("handles abort failure gracefully", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.registry.register("t1", "alice", "sess-a")
    deps.client.session.abort = async () => { throw new Error("abort failed") }

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    // Should not throw
    await watchdog.check()

    // Member should still be marked timed_out despite abort failure
    const row = deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("error")
    expect(row.execution_status).toBe("timed_out")
  })

  test("times out multiple stale members across teams", async () => {
    insertTeam(deps.db, "t2", "other-team", "lead-sess-2")
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t2", "bob", "sess-b", pastTime, pastTime]
    )

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    const alice = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    const bob = deps.db.query("SELECT status FROM team_member WHERE name = 'bob'").get() as Record<string, string>
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("error")
  })

  test("start and stop control the interval", () => {
    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000, checkIntervalMs: 60_000 })
    watchdog.start()
    expect(watchdog.isRunning()).toBe(true)
    watchdog.stop()
    expect(watchdog.isRunning()).toBe(false)
  })

  test("disabled when ttlMs is 0", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 0 })
    await watchdog.check()

    // Should not time out — disabled
    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("busy")
  })
})
