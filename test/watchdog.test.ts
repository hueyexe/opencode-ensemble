import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { Watchdog } from "../src/watchdog"
import { ProgressTracker } from "../src/progress"

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

  describe("stale worktree GC", () => {
    test("cleans up stale worktrees for shutdown members past threshold", async () => {
      const pastTime = Date.now() - 600_000 // 10 min ago
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated) VALUES (?, ?, ?, 'build', 'shutdown', 'completed', '/tmp/wt-alice', 'ensemble-alice', ?, ?)",
        ["t1", "alice", "sess-a", pastTime, pastTime]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      // worktree.remove should have been called
      const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(removeCalls).toHaveLength(1)
      expect((removeCalls[0]!.args[0] as Record<string, unknown>).worktreeRemoveInput).toEqual({ directory: "/tmp/wt-alice" })

      // DB should have worktree_dir NULLed
      const row = deps.db.query("SELECT worktree_dir, worktree_branch, workspace_id FROM team_member WHERE name = 'alice'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBeNull()
      expect(row.worktree_branch).toBeNull()
    })

    test("does NOT clean up recently-updated shutdown members", async () => {
      const now = Date.now()
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated) VALUES (?, ?, ?, 'build', 'shutdown', 'completed', '/tmp/wt-alice', 'ensemble-alice', ?, ?)",
        ["t1", "alice", "sess-a", now, now]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(removeCalls).toHaveLength(0)

      const row = deps.db.query("SELECT worktree_dir FROM team_member WHERE name = 'alice'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBe("/tmp/wt-alice")
    })

    test("cleans up workspace_id alongside worktree_dir", async () => {
      const pastTime = Date.now() - 600_000
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, workspace_id, time_created, time_updated) VALUES (?, ?, ?, 'build', 'shutdown', 'completed', '/tmp/wt-bob', 'ensemble-bob', 'ws-123', ?, ?)",
        ["t1", "bob", "sess-b", pastTime, pastTime]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      // Both workspace.remove and worktree.remove should be called
      const wsRemoveCalls = deps.client.calls.filter(c => c.method === "workspace.remove")
      expect(wsRemoveCalls).toHaveLength(1)
      expect((wsRemoveCalls[0]!.args[0] as Record<string, unknown>).id).toBe("ws-123")

      const wtRemoveCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(wtRemoveCalls).toHaveLength(1)

      // DB should have all three NULLed
      const row = deps.db.query("SELECT worktree_dir, worktree_branch, workspace_id FROM team_member WHERE name = 'bob'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBeNull()
      expect(row.worktree_branch).toBeNull()
      expect(row.workspace_id).toBeNull()
    })

    test("does NOT clean up worktrees for busy members", async () => {
      const pastTime = Date.now() - 600_000
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', '/tmp/wt-alice', 'ensemble-alice', ?, ?)",
        ["t1", "alice", "sess-a", pastTime, pastTime]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(removeCalls).toHaveLength(0)

      const row = deps.db.query("SELECT worktree_dir FROM team_member WHERE name = 'alice'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBe("/tmp/wt-alice")
    })
  })
})

describe("Watchdog.checkStalled — last_nudged_at, deferred markReported, completion guard", () => {
  let deps: ReturnType<typeof setupDeps>
  let pt: ProgressTracker

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    pt = new ProgressTracker()
  })

  function insertStalledMember(name: string, sessionId: string) {
    insertMember(deps.db, "t1", name, sessionId, "busy", "running")
    pt.recordBusyStart(sessionId)
    // isTimeStalled's baseline is max(msgAt, taskAt, lastStepAt, busySince) — age the
    // busySince entry directly so the member reads as stalled against a small threshold.
    const busySince = (pt as unknown as { busySince: Map<string, number> }).busySince
    busySince.set(sessionId, Date.now() - 10_000)
  }

  test("Fix 1: writes last_nudged_at on a successful nudge", async () => {
    insertStalledMember("alice", "sess-a")
    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt, stallThresholdMs: 5_000,
    })

    const before = Date.now()
    await watchdog.checkStalled()
    // Flush the promptAsync().then() microtask.
    await Promise.resolve()
    await Promise.resolve()

    const row = deps.db.query("SELECT last_nudged_at FROM team_member WHERE name = 'alice'").get() as { last_nudged_at: number | null }
    expect(row.last_nudged_at).not.toBeNull()
    expect(row.last_nudged_at!).toBeGreaterThanOrEqual(before)
  })

  test("Fix 4: markReported is deferred until promptAsync delivery succeeds — a failed delivery does not orphan the stall state permanently", async () => {
    insertStalledMember("alice", "sess-a")
    let attempt = 0
    const originalPromptAsync = deps.client.session.promptAsync.bind(deps.client.session)
    deps.client.session.promptAsync = async (opts) => {
      attempt++
      if (attempt === 1) throw new Error("session aborted")
      return originalPromptAsync(opts)
    }

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt, stallThresholdMs: 5_000,
    })

    await watchdog.checkStalled()
    await Promise.resolve()
    await Promise.resolve()

    // Delivery failed — markReported must NOT have fired, so a later check can retry.
    expect(pt.isReported("sess-a")).toBe(false)

    deps.client.calls.length = 0
    await watchdog.checkStalled()
    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(1) // retried, not permanently orphaned
    expect(attempt).toBe(2)
  })

  test("Fix 4: markReported fires after a successful delivery, preventing re-nudge on the next check", async () => {
    insertStalledMember("alice", "sess-a")
    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt, stallThresholdMs: 5_000,
    })

    await watchdog.checkStalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(pt.isReported("sess-a")).toBe(true)

    deps.client.calls.length = 0
    await watchdog.checkStalled()
    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0) // already reported, no duplicate nudge
  })

  test("Fix 2: logs a structured failure when the stall nudge delivery fails", async () => {
    insertStalledMember("alice", "sess-a")
    deps.client.session.promptAsync = async () => { throw new Error("session aborted") }
    const logCalls: string[] = []
    ;(deps.client as unknown as { app: { log: (p: { message: string }) => Promise<unknown> } }).app = { log: async (p) => { logCalls.push(p.message); return {} } }
    const { initLog } = await import("../src/log")
    initLog(deps.client)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt, stallThresholdMs: 5_000,
    })

    await watchdog.checkStalled()
    await Promise.resolve()
    await Promise.resolve()

    expect(logCalls.some(m => m.includes("alice") && m.includes("session aborted"))).toBe(true)
  })

  test("Fix 6: skips nudging a member who already reported completion, and logs the skip", async () => {
    insertStalledMember("alice", "sess-a")
    deps.db.run("UPDATE team_member SET reported_to_lead = 1 WHERE team_id = 't1' AND name = 'alice'")

    const logCalls: string[] = []
    ;(deps.client as unknown as { app: { log: (p: { message: string }) => Promise<unknown> } }).app = { log: async (p) => { logCalls.push(p.message); return {} } }
    const { initLog } = await import("../src/log")
    initLog(deps.client)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt, stallThresholdMs: 5_000,
    })

    await watchdog.checkStalled()

    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0)
    expect(logCalls.some(m => m.includes("alice"))).toBe(true)
  })

  test("Fix 6: checkChatty skips nudging a member who already reported completion, and logs the skip", async () => {
    insertMember(deps.db, "t1", "alice", "sess-a", "busy", "running")
    deps.db.run("UPDATE team_member SET reported_to_lead = 1 WHERE team_id = 't1' AND name = 'alice'")
    pt.recordPeerMessage("sess-a")
    pt.recordPeerMessage("sess-a")

    const logCalls: string[] = []
    ;(deps.client as unknown as { app: { log: (p: { message: string }) => Promise<unknown> } }).app = { log: async (p) => { logCalls.push(p.message); return {} } }
    const { initLog } = await import("../src/log")
    initLog(deps.client)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt, peerMessageLimit: 2, peerMessageWindowMs: 300_000,
    })

    await watchdog.checkChatty()

    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0)
    expect(logCalls.some(m => m.includes("alice"))).toBe(true)
  })
})