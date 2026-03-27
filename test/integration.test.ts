import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { buildLeadSystemPrompt } from "../src/system-prompt"
import { recoverStaleMembers } from "../src/recovery"
import { isWorktreeInstance } from "../src/util"
import type { ToolDeps } from "../src/types"

type Deps = ReturnType<typeof setupDeps>

describe("integration: full team lifecycle", () => {
  let deps: Deps
  const leadSession = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
  })

  test("create → spawn 4 → teammates message lead → lead receives → cleanup", async () => {
    // 1. Create team
    const createResult = await executeTeamCreate(deps, { name: "test-team" }, leadSession)
    expect(createResult).toContain("test-team")

    const team = deps.db.query("SELECT id FROM team WHERE name = 'test-team'").get() as { id: string }

    // 2. Spawn 4 teammates sequentially
    const names = ["alpha", "bravo", "charlie", "delta"]
    for (const name of names) {
      const result = await executeTeamSpawn(deps, { name, agent: "build", prompt: `Task for ${name}` }, leadSession)
      expect(result).toContain(name)
      expect(result).toContain("spawned")
    }

    // Verify: 4 members in DB
    const members = deps.db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(team.id) as Array<{ name: string; status: string }>
    expect(members).toHaveLength(4)
    for (const m of members) expect(m.status).toBe("busy")

    // Verify: 4 session.create + 4 promptAsync (fire-and-forget spawn prompts)
    expect(deps.client.calls.filter(c => c.method === "session.create")).toHaveLength(4)
    expect(deps.client.calls.filter(c => c.method === "session.promptAsync")).toHaveLength(4)

    // 3. Each teammate messages the lead
    for (const m of members) {
      const sessId = (deps.db.query("SELECT session_id FROM team_member WHERE team_id = ? AND name = ?").get(team.id, m.name) as { session_id: string }).session_id
      await executeTeamMessage(deps, { to: "lead", text: `${m.name} reporting done` }, sessId)
    }

    // Verify: 4 messages in DB with delivered=0
    const msgs = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ? AND to_name = 'lead'").all(team.id) as Array<{ delivered: number }>
    expect(msgs).toHaveLength(4)
    for (const msg of msgs) expect(msg.delivered).toBe(0)

    // Verify: 4 additional promptAsync wake-up calls (total now 8: 4 spawn + 4 wake)
    expect(deps.client.calls.filter(c => c.method === "session.promptAsync")).toHaveLength(8)

    // 4. Lead receives messages via system prompt transform
    const prompt = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt).toContain("--- Team Messages ---")
    expect(prompt).toContain("alpha reporting done")
    expect(prompt).toContain("bravo reporting done")
    expect(prompt).toContain("charlie reporting done")
    expect(prompt).toContain("delta reporting done")

    // Verify: all messages now delivered
    const delivered = deps.db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0").get(team.id) as { c: number }
    expect(delivered.c).toBe(0)

    // 5. Second call to buildLeadSystemPrompt has no messages section
    const prompt2 = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt2).not.toContain("--- Team Messages ---")

    // 6. Cleanup
    // Set members to ready so shutdown works without force
    deps.db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle' WHERE team_id = ?", [team.id])
    for (const name of names) {
      await executeTeamShutdown(deps, { member: name, force: true }, leadSession)
    }
    const cleanupResult = await executeTeamCleanup(deps, { force: false }, leadSession)
    expect(cleanupResult).toContain("cleaned up")

    // Verify: team archived, no active members
    const teamStatus = deps.db.query("SELECT status FROM team WHERE id = ?").get(team.id) as { status: string }
    expect(teamStatus.status).toBe("archived")
  })
})

describe("integration: parallel spawn race", () => {
  let deps: Deps
  const leadSession = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
  })

  test("4 concurrent spawns all succeed without timeout", async () => {
    await executeTeamCreate(deps, { name: "race-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'race-team'").get() as { id: string }

    const start = Date.now()
    const results = await Promise.all([
      executeTeamSpawn(deps, { name: "a", agent: "build", prompt: "task a", worktree: false }, leadSession),
      executeTeamSpawn(deps, { name: "b", agent: "build", prompt: "task b", worktree: false }, leadSession),
      executeTeamSpawn(deps, { name: "c", agent: "build", prompt: "task c", worktree: false }, leadSession),
      executeTeamSpawn(deps, { name: "d", agent: "build", prompt: "task d", worktree: false }, leadSession),
    ])
    const elapsed = Date.now() - start

    expect(results).toHaveLength(4)
    for (const r of results) expect(r).toContain("spawned")

    // Must complete in <5s (not 120s timeout)
    expect(elapsed).toBeLessThan(5000)

    // 4 distinct session IDs
    const sessions = deps.db.query("SELECT session_id FROM team_member WHERE team_id = ?").all(team.id) as Array<{ session_id: string }>
    const uniqueIds = new Set(sessions.map(s => s.session_id))
    expect(uniqueIds.size).toBe(4)
  })

  test("4 concurrent spawns with worktrees produce distinct directories", async () => {
    await executeTeamCreate(deps, { name: "wt-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'wt-team'").get() as { id: string }

    const results = await Promise.all([
      executeTeamSpawn(deps, { name: "w1", agent: "build", prompt: "task", worktree: true }, leadSession),
      executeTeamSpawn(deps, { name: "w2", agent: "build", prompt: "task", worktree: true }, leadSession),
      executeTeamSpawn(deps, { name: "w3", agent: "build", prompt: "task", worktree: true }, leadSession),
      executeTeamSpawn(deps, { name: "w4", agent: "build", prompt: "task", worktree: true }, leadSession),
    ])

    for (const r of results) expect(r).toContain("spawned")

    // 4 worktree.create calls with distinct names
    const wtCalls = deps.client.calls.filter(c => c.method === "worktree.create")
    expect(wtCalls).toHaveLength(4)
    const wtNames = new Set(wtCalls.map(c => (c.args[0] as { worktreeCreateInput: { name: string } }).worktreeCreateInput.name))
    expect(wtNames.size).toBe(4)
  })
})

describe("integration: worktree instance skips recovery (deadlock prevention)", () => {
  test("isWorktreeInstance detects worktree paths correctly", () => {
    expect(isWorktreeInstance("/home/user/.local/share/opencode/worktree/abc123/ensemble-team-alice")).toBe(true)
    expect(isWorktreeInstance("/home/user/repositories/my-project")).toBe(false)
    expect(isWorktreeInstance("/tmp/worktree/not-ensemble")).toBe(false)
    expect(isWorktreeInstance("")).toBe(false)
  })

  test("recovery would abort busy members — proving why it must be skipped in worktree instances", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")

    const result = await recoverStaleMembers(deps.db, deps.client)
    expect(result.interrupted).toBe(1)

    // Recovery called session.abort — this is the call that deadlocks during session.create
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
  })
})

describe("integration: spawn rollback notifies lead on failure", () => {
  let deps: Deps
  const leadSession = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
  })

  test("session.create failure cleans up and throws", async () => {
    await executeTeamCreate(deps, { name: "fail-team" }, leadSession)
    deps.client.session.create = async () => { throw new Error("server unavailable") }

    await expect(
      executeTeamSpawn(deps, { name: "doomed", agent: "build", prompt: "task" }, leadSession)
    ).rejects.toThrow("server unavailable")

    // No member left in DB
    const members = deps.db.query("SELECT * FROM team_member").all()
    expect(members).toHaveLength(0)
  })

  test("promptAsync failure triggers async rollback with lead notification", async () => {
    await executeTeamCreate(deps, { name: "rollback-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'rollback-team'").get() as { id: string }

    deps.client.session.promptAsync = async () => { throw new Error("delivery failed") }

    // Spawn returns successfully (fire-and-forget)
    const result = await executeTeamSpawn(deps, { name: "ghost", agent: "build", prompt: "task" }, leadSession)
    expect(result).toContain("ghost")
    expect(result).toContain("spawned")

    // Wait for async rollback
    await new Promise(resolve => setTimeout(resolve, 50))

    // Member cleaned up from DB
    const member = deps.db.query("SELECT * FROM team_member WHERE name = 'ghost'").get()
    expect(member).toBeNull()

    // System message sent to lead about the failure
    const msg = deps.db.query("SELECT content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name = 'system'").get(team.id) as { content: string } | null
    expect(msg).toBeTruthy()
    expect(msg!.content).toContain("ghost")
    expect(msg!.content).toContain("failed")
  })
})

describe("integration: message delivery pipeline end-to-end", () => {
  let deps: Deps
  const leadSession = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
  })

  test("teammate message → DB → wake-up promptAsync → system prompt delivery → marked delivered", async () => {
    // Setup: create team and spawn a teammate
    await executeTeamCreate(deps, { name: "msg-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'msg-team'").get() as { id: string }
    const spawnResult = await executeTeamSpawn(deps, { name: "worker", agent: "build", prompt: "do work" }, leadSession)
    expect(spawnResult).toContain("worker")

    const workerSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'worker'").get() as { session_id: string }).session_id
    deps.client.calls.length = 0 // reset call log

    // Step 1: Teammate sends message to lead
    const msgResult = await executeTeamMessage(deps, { to: "lead", text: "Found 3 issues in the auth module" }, workerSession)
    expect(msgResult).toContain("Message sent to lead")

    // Step 2: Message stored in DB with delivered=0
    const dbMsg = deps.db.query("SELECT * FROM team_message WHERE team_id = ? AND to_name = 'lead'").get(team.id) as { content: string; delivered: number }
    expect(dbMsg.content).toBe("Found 3 issues in the auth module")
    expect(dbMsg.delivered).toBe(0)

    // Step 3: Wake-up promptAsync fired (minimal, not full content)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const wakeText = (promptCalls[0]!.args[0] as { sessionID: string; parts: Array<{ text: string }> })
    expect(wakeText.sessionID).toBe(leadSession)
    expect(wakeText.parts[0]!.text).toContain("System")
    expect(wakeText.parts[0]!.text).toContain("worker")
    expect(wakeText.parts[0]!.text).not.toContain("Found 3 issues") // wake-up only, not content

    // Step 4: System prompt transform delivers actual content
    const prompt = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt).toContain("--- Team Messages ---")
    expect(prompt).toContain("[From worker]: Found 3 issues in the auth module")

    // Step 5: Message now marked delivered
    const afterDeliver = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ? AND to_name = 'lead'").get(team.id) as { delivered: number }
    expect(afterDeliver.delivered).toBe(1)

    // Step 6: Next system prompt has no messages
    const prompt2 = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt2).not.toContain("--- Team Messages ---")
  })

  test("long message is truncated in system prompt with team_results hint", async () => {
    await executeTeamCreate(deps, { name: "long-msg-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'long-msg-team'").get() as { id: string }
    await executeTeamSpawn(deps, { name: "verbose", agent: "build", prompt: "task" }, leadSession)
    const verboseSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'verbose'").get() as { session_id: string }).session_id

    const longText = "x".repeat(600)
    await executeTeamMessage(deps, { to: "lead", text: longText }, verboseSession)

    const prompt = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt).toContain("team_results to read full message")
    expect(prompt).not.toContain(longText) // full text NOT in prompt
  })

  test("member-to-member messages deliver via promptAsync with full content", async () => {
    await executeTeamCreate(deps, { name: "m2m-team" }, leadSession)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task", worktree: false }, leadSession)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task", worktree: false }, leadSession)

    const aliceSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'alice'").get() as { session_id: string }).session_id
    const bobSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'bob'").get() as { session_id: string }).session_id
    deps.client.calls.length = 0

    await executeTeamMessage(deps, { to: "bob", text: "can you check the tests?" }, aliceSession)

    // promptAsync delivers full content to bob's session
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const call = promptCalls[0]!.args[0] as { sessionID: string; parts: Array<{ text: string }> }
    expect(call.sessionID).toBe(bobSession)
    expect(call.parts[0]!.text).toContain("can you check the tests?")
  })
})

describe("integration: race conditions and edge cases", () => {
  let deps: Deps
  const leadSession = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
  })

  test("3 teammates message the lead simultaneously — all messages stored and wake-ups fired", async () => {
    await executeTeamCreate(deps, { name: "race-msg-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'race-msg-team'").get() as { id: string }

    const names = ["x", "y", "z"]
    const sessions: string[] = []
    for (const name of names) {
      await executeTeamSpawn(deps, { name, agent: "build", prompt: "task", worktree: false }, leadSession)
      sessions.push((deps.db.query("SELECT session_id FROM team_member WHERE name = ?").get(name) as { session_id: string }).session_id)
    }
    deps.client.calls.length = 0

    // All 3 message the lead concurrently
    await Promise.all([
      executeTeamMessage(deps, { to: "lead", text: "x done" }, sessions[0]!),
      executeTeamMessage(deps, { to: "lead", text: "y done" }, sessions[1]!),
      executeTeamMessage(deps, { to: "lead", text: "z done" }, sessions[2]!),
    ])

    // 3 messages in DB
    const msgs = deps.db.query("SELECT content FROM team_message WHERE team_id = ? AND to_name = 'lead' ORDER BY time_created").all(team.id) as Array<{ content: string }>
    expect(msgs).toHaveLength(3)

    // 3 wake-up promptAsync calls
    const wakes = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(wakes).toHaveLength(3)

    // System prompt delivers all 3
    const prompt = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt).toContain("x done")
    expect(prompt).toContain("y done")
    expect(prompt).toContain("z done")
  })

  test("buildLeadSystemPrompt called twice — second call sees no messages (no duplication)", async () => {
    await executeTeamCreate(deps, { name: "double-call-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'double-call-team'").get() as { id: string }
    await executeTeamSpawn(deps, { name: "worker", agent: "build", prompt: "task", worktree: false }, leadSession)
    const workerSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'worker'").get() as { session_id: string }).session_id

    await executeTeamMessage(deps, { to: "lead", text: "important finding" }, workerSession)

    // First call delivers the message
    const prompt1 = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt1).toContain("important finding")
    expect(prompt1).toContain("--- Team Messages ---")

    // Second call — message already delivered, no messages section
    const prompt2 = buildLeadSystemPrompt(deps.db, team.id)
    expect(prompt2).not.toContain("--- Team Messages ---")
    expect(prompt2).not.toContain("important finding")

    // Only 1 message in DB, marked delivered
    const msgs = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ? AND to_name = 'lead'").all(team.id) as Array<{ delivered: number }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.delivered).toBe(1)
  })

  test("slow session.create does not block other spawns from returning", async () => {
    await executeTeamCreate(deps, { name: "slow-team" }, leadSession)

    let createCount = 0
    deps.client.session.create = async (opts: unknown) => {
      createCount++
      deps.client.calls.push({ method: "session.create", args: [opts] })
      // Third spawn takes 200ms — simulates server load
      if (createCount === 3) await new Promise(resolve => setTimeout(resolve, 200))
      return { data: { id: `sess-${createCount}` } }
    }

    const start = Date.now()
    const results = await Promise.all([
      executeTeamSpawn(deps, { name: "fast1", agent: "build", prompt: "t", worktree: false }, leadSession),
      executeTeamSpawn(deps, { name: "fast2", agent: "build", prompt: "t", worktree: false }, leadSession),
      executeTeamSpawn(deps, { name: "slow", agent: "build", prompt: "t", worktree: false }, leadSession),
    ])
    const elapsed = Date.now() - start

    // All 3 succeed
    for (const r of results) expect(r).toContain("spawned")

    // Total time should be ~200ms (parallel), not 200ms * 3 (serial)
    expect(elapsed).toBeLessThan(1000)
  })

  test("teammate messaging lead after team cleanup throws — team no longer active", async () => {
    await executeTeamCreate(deps, { name: "late-msg-team" }, leadSession)
    await executeTeamSpawn(deps, { name: "straggler", agent: "build", prompt: "task", worktree: false }, leadSession)
    const stragglerSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'straggler'").get() as { session_id: string }).session_id

    // Force cleanup while teammate is still "working"
    await executeTeamCleanup(deps, { force: true }, leadSession)

    // Teammate tries to message lead after cleanup — team is archived
    await expect(
      executeTeamMessage(deps, { to: "lead", text: "late report" }, stragglerSession)
    ).rejects.toThrow("not in a team")
  })
})
