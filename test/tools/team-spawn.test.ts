import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamSpawn } from "../../src/tools/team-spawn"
import type { ToolDeps } from "../../src/types"

describe("team_spawn", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("spawns a teammate and registers in DB + registry", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    expect(result).toContain("alice")
    expect(result).toContain("spawned")

    // Check DB
    const row = deps.db.query("SELECT * FROM team_member WHERE name = ?").get("alice") as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.agent).toBe("build")
    expect(row.status).toBe("busy")
    expect(row.execution_status).toBe("starting")

    // Check registry
    expect(deps.registry.isTeamSession(row.session_id as string)).toBe(true)

    // Check client calls: session.create + promptAsync
    const createCalls = deps.client.calls.filter(c => c.method === "session.create")
    expect(createCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })

  test("rejects if caller is not the lead", async () => {
    insertMember(deps.db, "t1", "bob", "bob-sess")
    deps.registry.register("t1", "bob", "bob-sess")

    await expect(executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "bob-sess")).rejects.toThrow("Only the team lead")
  })

  test("rejects duplicate member name", async () => {
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task 1" }, "lead-sess")
    await expect(executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task 2" }, "lead-sess"))
      .rejects.toThrow("already exists")
  })

  test("rejects if session is not in any team", async () => {
    await expect(executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "random-sess")).rejects.toThrow("not in a team")
  })

  test("rejects invalid member name", async () => {
    await expect(executeTeamSpawn(deps, {
      name: "lead",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")).rejects.toThrow("reserved")
  })

  test("context message instructs teammate to mark tasks complete before messaging lead", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    expect(promptCall).toBeTruthy()
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    // Should instruct to mark task complete
    expect(text).toContain("team_tasks_complete")
    // Should NOT have the old "STOP" as step 2 without mentioning task completion first
    expect(text).toMatch(/mark.*complete.*team_message/s)
  })

  test("context message includes assigned task when claim_task is provided", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
      claim_task: "task-123",
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    expect(promptCall).toBeTruthy()
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    expect(text).toContain("task-123")
    expect(text).toContain("Mark it complete when done")
  })

  test("context message does NOT include assigned task line when claim_task is absent", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    expect(promptCall).toBeTruthy()
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    expect(text).not.toContain("You have been assigned task")
  })

  test("response includes task summary without LLM instructions", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    expect(result).toContain("alice")
    expect(result).toContain("Fix the tests")
    expect(result).not.toContain("STOP")
    expect(result).not.toContain("Do NOT call")
    expect(result).not.toContain("woken automatically")
  })

  test("rolls back DB, registry, and aborts session if promptAsync fails", async () => {
    // Make promptAsync throw after session.create succeeds
    deps.client.session.promptAsync = async () => { throw new Error("promptAsync failed") }

    await expect(executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")).rejects.toThrow("Failed to send initial prompt")

    // DB should have no member
    const row = deps.db.query("SELECT * FROM team_member WHERE name = 'alice'").get()
    expect(row).toBeNull()

    // Registry should be clean
    const members = deps.registry.listByTeam("t1")
    expect(members).toHaveLength(0)

    // session.abort should have been called
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
  })

  test("response is clean without LLM instructions", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    expect(result).toContain("alice")
    expect(result).not.toContain("Do NOT call any tools")
    expect(result).not.toContain("STOP")
  })

  test("rolls back cleanly even if session.abort fails during promptAsync rollback", async () => {
    deps.client.session.promptAsync = async () => { throw new Error("promptAsync failed") }
    deps.client.session.abort = async () => { throw new Error("abort also failed") }

    await expect(executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")).rejects.toThrow("Failed to send initial prompt")

    // DB and registry should still be cleaned up
    const row = deps.db.query("SELECT * FROM team_member WHERE name = 'alice'").get()
    expect(row).toBeNull()
    expect(deps.registry.listByTeam("t1")).toHaveLength(0)
  })

  // --- Worktree tests ---

  test("creates a worktree by default and stores dir/branch in DB", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    // Worktree.create should have been called
    const wtCalls = deps.client.calls.filter(c => c.method === "worktree.create")
    expect(wtCalls).toHaveLength(1)
    expect((wtCalls[0]!.args[0] as Record<string, unknown>).worktreeCreateInput).toEqual({ name: "ensemble-my-team-alice" })

    // DB should have worktree columns populated
    const row = deps.db.query("SELECT worktree_dir, worktree_branch FROM team_member WHERE name = ?").get("alice") as Record<string, string | null>
    expect(row.worktree_dir).toBeTruthy()
    expect(row.worktree_branch).toBeTruthy()

    // Result should mention the branch
    expect(result).toContain("branch:")
  })

  test("skips worktree when worktree: false", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "explore",
      prompt: "Research the codebase",
      worktree: false,
    }, "lead-sess")

    // No worktree.create call
    const wtCalls = deps.client.calls.filter(c => c.method === "worktree.create")
    expect(wtCalls).toHaveLength(0)

    // DB should have null worktree columns
    const row = deps.db.query("SELECT worktree_dir, worktree_branch FROM team_member WHERE name = ?").get("alice") as Record<string, string | null>
    expect(row.worktree_dir).toBeNull()
    expect(row.worktree_branch).toBeNull()

    // Result should not mention branch
    expect(result).not.toContain("branch:")
  })

  test("falls back to shared directory if worktree creation fails", async () => {
    deps.client.worktree.create = async () => { throw new Error("worktree failed") }

    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    // Should still succeed — just without worktree
    expect(result).toContain("alice")
    expect(result).toContain("spawned")

    // DB should have null worktree columns
    const row = deps.db.query("SELECT worktree_dir, worktree_branch FROM team_member WHERE name = ?").get("alice") as Record<string, string | null>
    expect(row.worktree_dir).toBeNull()
    expect(row.worktree_branch).toBeNull()

    // Toast warning should have been fired
    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts.length).toBeGreaterThan(0)
  })

  test("rolls back worktree if promptAsync fails", async () => {
    deps.client.session.promptAsync = async () => { throw new Error("promptAsync failed") }

    await expect(executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")).rejects.toThrow("Failed to send initial prompt")

    // Worktree should have been removed during rollback
    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)
  })

  test("context message mentions branch when worktree is active", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    expect(text).toContain("worktree")
    expect(text).toContain("branch")
  })

  test("context message does not mention worktree when worktree: false", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "explore",
      prompt: "Research",
      worktree: false,
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    expect(text).not.toContain("worktree")
  })
})

describe("team_spawn — plan approval", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("sets plan_approval='pending' in DB when plan_approval: true", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Refactor auth",
      plan_approval: true,
    }, "lead-sess")

    const row = deps.db.query("SELECT plan_approval FROM team_member WHERE name = ?").get("alice") as { plan_approval: string }
    expect(row.plan_approval).toBe("pending")
  })

  test("sets plan_approval='none' in DB when plan_approval is not set", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix tests",
    }, "lead-sess")

    const row = deps.db.query("SELECT plan_approval FROM team_member WHERE name = ?").get("alice") as { plan_approval: string }
    expect(row.plan_approval).toBe("none")
  })

  test("context message includes PLAN MODE instructions when plan_approval: true", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Refactor auth",
      plan_approval: true,
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    expect(text).toContain("PLAN MODE")
    expect(text).toContain("Do NOT write or modify any files")
    expect(text).toContain("approval")
  })

  test("context message does NOT include PLAN MODE when plan_approval is false/absent", async () => {
    await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix tests",
    }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

    expect(text).not.toContain("PLAN MODE")
  })

  test("return message includes plan mode indicator when plan_approval: true", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Refactor auth",
      plan_approval: true,
    }, "lead-sess")

    expect(result).toContain("plan mode")
  })
})

describe("team_spawn — agent mode enforcement", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("plan agent gets permission deny rules on session.create", async () => {
    await executeTeamSpawn(deps, { name: "planner", agent: "plan", prompt: "Plan it" }, "lead-sess")

    const createCall = deps.client.calls.find(c => c.method === "session.create")
    const opts = createCall!.args[0] as { permission?: Array<{ permission: string; pattern: string; action: string }> }
    expect(opts.permission).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
  })

  test("explore agent gets permission deny rules on session.create", async () => {
    await executeTeamSpawn(deps, { name: "explorer", agent: "explore", prompt: "Explore it" }, "lead-sess")

    const createCall = deps.client.calls.find(c => c.method === "session.create")
    const opts = createCall!.args[0] as { permission?: Array<{ permission: string; pattern: string; action: string }> }
    expect(opts.permission).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
  })

  test("build agent does NOT get permission rules on session.create", async () => {
    await executeTeamSpawn(deps, { name: "builder", agent: "build", prompt: "Build it" }, "lead-sess")

    const createCall = deps.client.calls.find(c => c.method === "session.create")
    const opts = createCall!.args[0] as { permission?: unknown }
    expect(opts.permission).toBeUndefined()
  })

  test("plan agent gets tools restriction and agent type on promptAsync", async () => {
    await executeTeamSpawn(deps, { name: "planner", agent: "plan", prompt: "Plan it" }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const opts = promptCall!.args[0] as { agent?: string; tools?: Record<string, boolean> }
    expect(opts.agent).toBe("plan")
    expect(opts.tools).toEqual({ edit: false, bash: false, team_message: true, team_broadcast: true, team_tasks_list: true, team_tasks_add: true, team_tasks_complete: true, team_claim: true })
  })

  test("explore agent gets tools restriction and agent type on promptAsync", async () => {
    await executeTeamSpawn(deps, { name: "explorer", agent: "explore", prompt: "Explore it" }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const opts = promptCall!.args[0] as { agent?: string; tools?: Record<string, boolean> }
    expect(opts.agent).toBe("explore")
    expect(opts.tools).toEqual({ edit: false, bash: false, team_message: true, team_broadcast: true, team_tasks_list: true, team_tasks_add: true, team_tasks_complete: true, team_claim: true })
  })

  test("build agent does NOT get tools restriction on promptAsync", async () => {
    await executeTeamSpawn(deps, { name: "builder", agent: "build", prompt: "Build it" }, "lead-sess")

    const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
    const opts = promptCall!.args[0] as { agent?: string; tools?: unknown }
    expect(opts.agent).toBe("build")
    expect(opts.tools).toBeUndefined()
  })
})

describe("team_spawn — AGENTS.md loading", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("includes AGENTS.md content in context message when file exists", async () => {
    // Create a temporary AGENTS.md in the test directory
    const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/ensemble-test-"))
    const agentsPath = `${tmpDir}/AGENTS.md`
    await Bun.write(agentsPath, "# Test Guidelines\nUse TypeScript strict mode.")
    deps.directory = tmpDir

    try {
      await executeTeamSpawn(deps, {
        name: "alice",
        agent: "build",
        prompt: "Fix tests",
      }, "lead-sess")

      const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
      const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

      expect(text).toContain("Project guidelines (from AGENTS.md)")
      expect(text).toContain("Use TypeScript strict mode")
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true }))
    }
  })

  test("does not error when AGENTS.md does not exist", async () => {
    deps.directory = "/tmp/nonexistent-dir-ensemble-test"

    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix tests",
    }, "lead-sess")

    expect(result).toContain("alice")
    expect(result).toContain("spawned")
  })

  test("truncates AGENTS.md content to 2000 chars", async () => {
    const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/ensemble-test-"))
    const agentsPath = `${tmpDir}/AGENTS.md`
    const longContent = "x".repeat(3000)
    await Bun.write(agentsPath, longContent)
    deps.directory = tmpDir

    try {
      await executeTeamSpawn(deps, {
        name: "alice",
        agent: "build",
        prompt: "Fix tests",
      }, "lead-sess")

      const promptCall = deps.client.calls.find(c => c.method === "session.promptAsync")
      const text = (promptCall!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text

      expect(text).toContain("...(truncated)")
      // The AGENTS.md portion should be at most 2000 chars + truncation marker
      expect(text).not.toContain("x".repeat(2001))
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true }))
    }
  })
})
