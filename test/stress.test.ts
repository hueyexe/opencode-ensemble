import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { spawnFailures } from "../src/tools/team-spawn"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import type { MergeBranchFn, DeleteBranchFn } from "../src/tools/merge-helper"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamStatus } from "../src/tools/team-status"
import { lastCallTime } from "../src/tools/team-status"
import { buildLeadSystemPrompt, buildTeamCompactionContext } from "../src/system-prompt"
import { ProgressTracker } from "../src/progress"
import { Watchdog } from "../src/watchdog"
import { loadConfig, DEFAULT_CONFIG } from "../src/config"
import { sendMessage } from "../src/messaging"
import type { ToolDeps } from "../src/types"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

type Deps = ReturnType<typeof setupDeps>

/** Noop merge for tests that don't need real git. */
const noopMerge: MergeBranchFn = async () => ({ ok: true })
const noopDelete: DeleteBranchFn = async () => true

/** Failing merge for conflict tests. */
const failMerge: MergeBranchFn = async () => ({ ok: false, error: "conflict" })

// Helper to get a member's session ID
function getSession(deps: Deps, name: string): string {
  return (deps.db.query("SELECT session_id FROM team_member WHERE name = ?").get(name) as { session_id: string }).session_id
}

// Helper to get team ID by name
function getTeamId(deps: Deps, name: string): string {
  return (deps.db.query("SELECT id FROM team WHERE name = ?").get(name) as { id: string }).id
}

// ─── Config validation ───

describe("stress: config validation", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ensemble-stress-"))
  })

  test("invalid types in config are ignored", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      stallThresholdMs: "not a number",
      mergeOnCleanup: "yes",
      rateLimitCapacity: null,
      timeoutMs: 42,
    }))
    const config = loadConfig(tmpDir)
    // Invalid types fall back to defaults
    expect(config.stallThresholdMs).toBe(DEFAULT_CONFIG.stallThresholdMs)
    expect(config.mergeOnCleanup).toBe(DEFAULT_CONFIG.mergeOnCleanup)
    expect(config.rateLimitCapacity).toBe(DEFAULT_CONFIG.rateLimitCapacity)
    // Valid type is accepted
    expect(config.timeoutMs).toBe(42)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("negative numbers are accepted (user responsibility)", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      stallThresholdMs: -1,
    }))
    const config = loadConfig(tmpDir)
    expect(config.stallThresholdMs).toBe(-1)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ─── Auto-merge ordering ───

describe("stress: auto-merge on cleanup", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    lastCallTime.clear()
    spawnFailures.clear()
  })

  test("merge runs before worktree removal — merge fn sees branches", async () => {
    await executeTeamCreate(deps, { name: "merge-order" }, lead)
    const teamId = getTeamId(deps, "merge-order")
    await executeTeamSpawn(deps, { name: "a", agent: "build", prompt: "t" }, lead)
    await executeTeamSpawn(deps, { name: "b", agent: "build", prompt: "t" }, lead)

    // Shutdown both
    deps.db.run("UPDATE team_member SET status = 'shutdown', execution_status = 'completed' WHERE team_id = ?", [teamId])

    const mergedBranches: string[] = []
    const trackMerge: MergeBranchFn = async (branch) => {
      mergedBranches.push(branch)
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true)
    expect(result).toContain("Safety-net merged 2 unmerged branch")
    expect(mergedBranches).toHaveLength(2)

    // Worktree removal happened AFTER merge
    const wtRemoves = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(wtRemoves).toHaveLength(2)
  })

  test("mixed merge success and conflict reports both", async () => {
    await executeTeamCreate(deps, { name: "mix-merge" }, lead)
    const teamId = getTeamId(deps, "mix-merge")
    await executeTeamSpawn(deps, { name: "ok", agent: "build", prompt: "t" }, lead)
    await executeTeamSpawn(deps, { name: "bad", agent: "build", prompt: "t" }, lead)
    deps.db.run("UPDATE team_member SET status = 'shutdown', execution_status = 'completed' WHERE team_id = ?", [teamId])

    let mixedCallCount = 0
    const mixedMerge: MergeBranchFn = async () => {
      mixedCallCount++
      return mixedCallCount === 1 ? { ok: true } : { ok: false, error: "conflict" }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, mixedMerge, noopDelete, true)
    expect(result).toContain("Safety-net merged 1 unmerged branch")
    expect(result).toContain("Could not auto-merge")
  })

  test("all merges fail — only conflict message shown", async () => {
    await executeTeamCreate(deps, { name: "all-fail" }, lead)
    const teamId = getTeamId(deps, "all-fail")
    await executeTeamSpawn(deps, { name: "x", agent: "build", prompt: "t" }, lead)
    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE team_id = ?", [teamId])

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, failMerge, noopDelete, true)
    expect(result).toContain("Could not auto-merge")
    expect(result).not.toContain("Merged")
  })

  test("mergeOnCleanup=false returns old-style merge commands", async () => {
    await executeTeamCreate(deps, { name: "no-merge" }, lead)
    const teamId = getTeamId(deps, "no-merge")
    await executeTeamSpawn(deps, { name: "y", agent: "build", prompt: "t" }, lead)
    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE team_id = ?", [teamId])

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, noopMerge, noopDelete, false)
  })
})

// ─── Spawn circuit breaker ───

describe("stress: spawn circuit breaker", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("trips after 3 consecutive session.create failures", async () => {
    await executeTeamCreate(deps, { name: "breaker-team" }, lead)
    const teamId = getTeamId(deps, "breaker-team")

    deps.client.session.create = async () => { throw new Error("server down") }

    // First two failures throw but don't trip breaker
    await expect(executeTeamSpawn(deps, { name: "a", agent: "build", prompt: "t" }, lead)).rejects.toThrow("server down")
    await expect(executeTeamSpawn(deps, { name: "b", agent: "build", prompt: "t" }, lead)).rejects.toThrow("server down")

    // Third failure trips the breaker
    await expect(executeTeamSpawn(deps, { name: "c", agent: "build", prompt: "t" }, lead)).rejects.toThrow("server down")

    // Fourth attempt blocked by circuit breaker (different error)
    await expect(executeTeamSpawn(deps, { name: "d", agent: "build", prompt: "t" }, lead)).rejects.toThrow("circuit breaker")
  })

  test("resets after a successful spawn", async () => {
    await executeTeamCreate(deps, { name: "reset-team" }, lead)
    const teamId = getTeamId(deps, "reset-team")

    // Manually set 2 failures
    spawnFailures.set(teamId, { count: 2, lastError: "prev error" })

    // Successful spawn resets
    const result = await executeTeamSpawn(deps, { name: "ok", agent: "build", prompt: "t", worktree: false }, lead)
    expect(result).toContain("spawned")
    expect(spawnFailures.has(teamId)).toBe(false)
  })

  test("per-team isolation — failures in one team don't affect another", async () => {
    await executeTeamCreate(deps, { name: "team-a" }, lead)
    const teamAId = getTeamId(deps, "team-a")
    spawnFailures.set(teamAId, { count: 3, lastError: "dead" })

    // Create a second team from a different lead session
    const lead2 = "lead-sess-2"
    await executeTeamCreate(deps, { name: "team-b" }, lead2)

    // team-b can still spawn fine
    const result = await executeTeamSpawn(deps, { name: "fine", agent: "build", prompt: "t", worktree: false }, lead2)
    expect(result).toContain("spawned")
  })

  test("cleanup clears circuit breaker state", async () => {
    await executeTeamCreate(deps, { name: "cleanup-breaker" }, lead)
    const teamId = getTeamId(deps, "cleanup-breaker")
    spawnFailures.set(teamId, { count: 3, lastError: "stuck" })

    await executeTeamCleanup(deps, { force: true }, lead, undefined, noopMerge, noopDelete, false)
    expect(spawnFailures.has(teamId)).toBe(false)
  })
})

// ─── Stall detection ───

describe("stress: stall detection via watchdog", () => {
  let deps: Deps
  let pt: ProgressTracker
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    pt = new ProgressTracker()
    spawnFailures.clear()
  })

  test("token-stalled member gets nudged and lead notified", async () => {
    await executeTeamCreate(deps, { name: "stall-team" }, lead)
    const teamId = getTeamId(deps, "stall-team")
    await executeTeamSpawn(deps, { name: "stuck", agent: "build", prompt: "do work", worktree: false }, lead)
    const stuckSess = getSession(deps, "stuck")

    // Simulate 3 low-token steps
    pt.recordStep(stuckSess, 50)
    pt.recordStep(stuckSess, 30)
    pt.recordStep(stuckSess, 10)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt,
      stallThresholdMs: 180_000, stallMinSteps: 3, stallTokenThreshold: 500,
    })

    deps.client.calls.length = 0
    await watchdog.checkStalled()

    // Teammate was nudged via promptAsync
    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(1)
    const nudgeText = (nudges[0]!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text
    expect(nudgeText).toContain("stalled")

    // Lead was notified via system message
    const msg = deps.db.query(
      "SELECT content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name = 'system'"
    ).get(teamId) as { content: string } | null
    expect(msg).toBeTruthy()
    expect(msg!.content).toContain("stuck")
    expect(msg!.content).toContain("stalled")

    // Toast fired
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts.length).toBeGreaterThanOrEqual(1)
  })

  test("stall is not re-reported until activity clears it", async () => {
    await executeTeamCreate(deps, { name: "dedup-team" }, lead)
    const teamId = getTeamId(deps, "dedup-team")
    await executeTeamSpawn(deps, { name: "dup", agent: "build", prompt: "t", worktree: false }, lead)
    const sess = getSession(deps, "dup")

    pt.recordStep(sess, 10)
    pt.recordStep(sess, 10)
    pt.recordStep(sess, 10)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt,
      stallThresholdMs: 180_000, stallMinSteps: 3, stallTokenThreshold: 500,
    })

    await watchdog.checkStalled()
    deps.client.calls.length = 0

    // Second check — already reported, no new nudge
    await watchdog.checkStalled()
    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0)

    // Activity clears the report
    pt.recordMessage(sess)
    pt.recordStep(sess, 10)
    pt.recordStep(sess, 10)
    pt.recordStep(sess, 10)
    deps.client.calls.length = 0

    // Now it fires again
    await watchdog.checkStalled()
    const nudges2 = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges2).toHaveLength(1)
  })

  test("active member is not flagged as stalled", async () => {
    await executeTeamCreate(deps, { name: "active-team" }, lead)
    await executeTeamSpawn(deps, { name: "busy", agent: "build", prompt: "t", worktree: false }, lead)
    const sess = getSession(deps, "busy")

    // High-token steps — not stalled
    pt.recordStep(sess, 1000)
    pt.recordStep(sess, 800)
    pt.recordStep(sess, 900)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt,
      stallThresholdMs: 180_000, stallMinSteps: 3, stallTokenThreshold: 500,
    })

    deps.client.calls.length = 0
    await watchdog.checkStalled()

    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0)
  })

  test("shutdown members are not checked for stalls", async () => {
    await executeTeamCreate(deps, { name: "shut-team" }, lead)
    const teamId = getTeamId(deps, "shut-team")
    await executeTeamSpawn(deps, { name: "done", agent: "build", prompt: "t", worktree: false }, lead)
    const sess = getSession(deps, "done")

    pt.recordStep(sess, 10)
    pt.recordStep(sess, 10)
    pt.recordStep(sess, 10)

    // Mark as shutdown
    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE name = 'done'")

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt,
      stallThresholdMs: 180_000, stallMinSteps: 3, stallTokenThreshold: 500,
    })

    deps.client.calls.length = 0
    await watchdog.checkStalled()

    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0)
  })
})

// ─── System prompt enhancements ───

describe("stress: system prompt inline tasks + compaction", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("lead system prompt shows in-progress and completed tasks", async () => {
    await executeTeamCreate(deps, { name: "prompt-team" }, lead)
    const teamId = getTeamId(deps, "prompt-team")
    await executeTeamSpawn(deps, { name: "w1", agent: "build", prompt: "t", worktree: false }, lead)
    const w1Sess = getSession(deps, "w1")

    // Add tasks and complete one
    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix auth middleware", priority: "high" },
      { content: "Add rate limiting", priority: "medium" },
    ] }, w1Sess)

    const tasks = deps.db.query("SELECT id FROM team_task WHERE team_id = ?").all(teamId) as Array<{ id: string }>
    await executeTeamClaim(deps, { task_id: tasks[0]!.id }, w1Sess)
    await executeTeamTasksComplete(deps, { task_id: tasks[0]!.id }, w1Sess)
    await executeTeamClaim(deps, { task_id: tasks[1]!.id }, w1Sess)

    const prompt = buildLeadSystemPrompt(deps.db, teamId)
    expect(prompt).toContain("Active tasks:")
    expect(prompt).toContain("[in_progress]")
    expect(prompt).toContain("Add rate limiting")
    expect(prompt).toContain("Recently completed:")
    expect(prompt).toContain("[completed]")
    expect(prompt).toContain("Fix auth middleware")
  })

  test("task content is truncated at 120 chars in lead prompt", async () => {
    await executeTeamCreate(deps, { name: "trunc-team" }, lead)
    const teamId = getTeamId(deps, "trunc-team")
    await executeTeamSpawn(deps, { name: "w", agent: "build", prompt: "t", worktree: false }, lead)
    const wSess = getSession(deps, "w")

    const longContent = "x".repeat(200)
    await executeTeamTasksAdd(deps, { tasks: [{ content: longContent, priority: "high" }] }, wSess)
    const task = deps.db.query("SELECT id FROM team_task WHERE team_id = ?").get(teamId) as { id: string }
    await executeTeamClaim(deps, { task_id: task.id }, wSess)

    const prompt = buildLeadSystemPrompt(deps.db, teamId)
    expect(prompt).not.toContain(longContent)
    expect(prompt).toContain("x".repeat(120) + "...")
  })

  test("compaction context includes original task prompt for members", async () => {
    await executeTeamCreate(deps, { name: "compact-team" }, lead)
    const teamId = getTeamId(deps, "compact-team")
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "Refactor the auth module to use JWT tokens" }, lead)

    const ctx = buildTeamCompactionContext(deps.db, teamId, "member", "alice")
    expect(ctx).toContain("Your original task:")
    expect(ctx).toContain("Refactor the auth module")
  })

  test("compaction context includes recent messages for members", async () => {
    await executeTeamCreate(deps, { name: "msg-compact" }, lead)
    const teamId = getTeamId(deps, "msg-compact")
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task", worktree: false }, lead)
    const bobSess = getSession(deps, "bob")

    await executeTeamMessage(deps, { to: "lead", text: "Found a bug in auth" }, bobSess)

    const ctx = buildTeamCompactionContext(deps.db, teamId, "member", "bob")
    expect(ctx).toContain("Recent context:")
    expect(ctx).toContain("Found a bug in auth")
  })

  test("compaction context includes completed tasks for lead", async () => {
    await executeTeamCreate(deps, { name: "lead-compact" }, lead)
    const teamId = getTeamId(deps, "lead-compact")
    await executeTeamSpawn(deps, { name: "w", agent: "build", prompt: "t", worktree: false }, lead)
    const wSess = getSession(deps, "w")

    await executeTeamTasksAdd(deps, { tasks: [{ content: "Setup database", priority: "high" }] }, wSess)
    const task = deps.db.query("SELECT id FROM team_task WHERE team_id = ?").get(teamId) as { id: string }
    await executeTeamClaim(deps, { task_id: task.id }, wSess)
    await executeTeamTasksComplete(deps, { task_id: task.id }, wSess)

    const ctx = buildTeamCompactionContext(deps.db, teamId, "lead")
    expect(ctx).toContain("Recently completed:")
    expect(ctx).toContain("Setup database")
  })
})

// ─── Richer team_status ───

describe("stress: richer team_status output", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    lastCallTime.clear()
    spawnFailures.clear()
  })

  test("shows duration, last message time, and current task", async () => {
    await executeTeamCreate(deps, { name: "status-team" }, lead)
    const teamId = getTeamId(deps, "status-team")
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "t", worktree: false }, lead)
    const aliceSess = getSession(deps, "alice")

    // Alice sends a message and claims a task
    await executeTeamMessage(deps, { to: "lead", text: "progress update" }, aliceSess)
    await executeTeamTasksAdd(deps, { tasks: [{ content: "Fix the login page", priority: "high" }] }, aliceSess)
    const task = deps.db.query("SELECT id FROM team_task WHERE team_id = ?").get(teamId) as { id: string }
    await executeTeamClaim(deps, { task_id: task.id }, aliceSess)

    const result = await executeTeamStatus(deps, lead)
    expect(result).toContain("alice")
    expect(result).toContain("working")
    expect(result).toContain("last msg:")
    expect(result).toContain("ago")
    expect(result).toContain("task: Fix the login page")
  })

  test("shows 'no messages yet' for members who haven't messaged", async () => {
    await executeTeamCreate(deps, { name: "quiet-team" }, lead)
    await executeTeamSpawn(deps, { name: "silent", agent: "build", prompt: "t", worktree: false }, lead)

    const result = await executeTeamStatus(deps, lead)
    expect(result).toContain("no messages yet")
  })

  test("truncates long task content at 80 chars", async () => {
    await executeTeamCreate(deps, { name: "long-task-team" }, lead)
    const teamId = getTeamId(deps, "long-task-team")
    await executeTeamSpawn(deps, { name: "w", agent: "build", prompt: "t", worktree: false }, lead)
    const wSess = getSession(deps, "w")

    const longTask = "a".repeat(120)
    await executeTeamTasksAdd(deps, { tasks: [{ content: longTask, priority: "high" }] }, wSess)
    const task = deps.db.query("SELECT id FROM team_task WHERE team_id = ?").get(teamId) as { id: string }
    await executeTeamClaim(deps, { task_id: task.id }, wSess)

    lastCallTime.clear()
    const result = await executeTeamStatus(deps, lead)
    expect(result).toContain("a".repeat(80) + "...")
    expect(result).not.toContain(longTask)
  })
})

// ─── Full lifecycle stress test ───

describe("stress: full lifecycle with all v0.8.0 features", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    lastCallTime.clear()
    spawnFailures.clear()
  })

  test("create → spawn 3 → tasks → messages → stall check → shutdown → merge cleanup", async () => {
    // 1. Create team
    await executeTeamCreate(deps, { name: "full-test" }, lead)
    const teamId = getTeamId(deps, "full-test")

    // 2. Spawn 3 teammates
    for (const name of ["alice", "bob", "carol"]) {
      const result = await executeTeamSpawn(deps, { name, agent: "build", prompt: `Task for ${name}`, worktree: false }, lead)
      expect(result).toContain("spawned")
    }
    expect(deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(teamId)).toEqual({ c: 3 })

    // 3. Add tasks and claim them
    const aliceSess = getSession(deps, "alice")
    const bobSess = getSession(deps, "bob")
    const carolSess = getSession(deps, "carol")

    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Implement auth", priority: "high" },
      { content: "Write tests", priority: "medium" },
      { content: "Update docs", priority: "low" },
    ] }, aliceSess)

    const tasks = deps.db.query("SELECT id FROM team_task WHERE team_id = ? ORDER BY time_created").all(teamId) as Array<{ id: string }>
    await executeTeamClaim(deps, { task_id: tasks[0]!.id }, aliceSess)
    await executeTeamClaim(deps, { task_id: tasks[1]!.id }, bobSess)
    await executeTeamClaim(deps, { task_id: tasks[2]!.id }, carolSess)

    // 4. Alice and bob complete, carol is still working
    await executeTeamTasksComplete(deps, { task_id: tasks[0]!.id }, aliceSess)
    await executeTeamTasksComplete(deps, { task_id: tasks[1]!.id }, bobSess)
    await executeTeamMessage(deps, { to: "lead", text: "Auth done, all tests passing" }, aliceSess)
    await executeTeamMessage(deps, { to: "lead", text: "Tests written, 15 cases" }, bobSess)

    // 5. Lead system prompt shows inline task details + messages
    const prompt = buildLeadSystemPrompt(deps.db, teamId)
    expect(prompt).toContain("Active tasks:")
    expect(prompt).toContain("Update docs")
    expect(prompt).toContain("Recently completed:")
    expect(prompt).toContain("Implement auth")
    expect(prompt).toContain("--- Team Messages ---")
    expect(prompt).toContain("Auth done")
    expect(prompt).toContain("Tests written")

    // 6. Stall check — carol hasn't messaged but is active (high tokens)
    const pt = new ProgressTracker()
    pt.recordStep(carolSess, 1000)
    pt.recordStep(carolSess, 800)
    pt.recordStep(carolSess, 900)

    const watchdog = new Watchdog({
      db: deps.db, client: deps.client, registry: deps.registry,
      ttlMs: 0, progressTracker: pt,
      stallThresholdMs: 180_000, stallMinSteps: 3, stallTokenThreshold: 500,
    })
    deps.client.calls.length = 0
    await watchdog.checkStalled()
    // Carol is NOT stalled (high token output)
    const nudges = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(nudges).toHaveLength(0)

    // 7. Carol finishes
    await executeTeamTasksComplete(deps, { task_id: tasks[2]!.id }, carolSess)
    await executeTeamMessage(deps, { to: "lead", text: "Docs updated" }, carolSess)

    // 8. Shutdown all
    deps.db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle' WHERE team_id = ?", [teamId])
    for (const name of ["alice", "bob", "carol"]) {
      await executeTeamShutdown(deps, { member: name, force: true }, lead)
    }

    // 9. Cleanup with auto-merge
    const mergedBranches: string[] = []
    const trackMerge: MergeBranchFn = async (branch) => {
      mergedBranches.push(branch)
      return { ok: true }
    }
    // Members don't have worktree branches (worktree: false), so no merge happens
    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true)
    expect(result).toContain("cleaned up")

    // 10. Team is archived, all tasks completed
    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get(teamId) as { status: string }
    expect(team.status).toBe("archived")
    const allTasks = deps.db.query("SELECT status FROM team_task WHERE team_id = ?").all(teamId) as Array<{ status: string }>
    expect(allTasks.every(t => t.status === "completed")).toBe(true)
  })
})
