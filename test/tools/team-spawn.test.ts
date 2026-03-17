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
    const body = (promptCall!.args[0] as { body: { parts: Array<{ text: string }> } }).body
    const text = body.parts[0]!.text

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
    const body = (promptCall!.args[0] as { body: { parts: Array<{ text: string }> } }).body
    const text = body.parts[0]!.text

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
    const body = (promptCall!.args[0] as { body: { parts: Array<{ text: string }> } }).body
    const text = body.parts[0]!.text

    expect(text).not.toContain("You have been assigned task")
  })

  test("response string tells lead to stop and wait", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    expect(result).toContain("STOP")
    expect(result).toContain("woken automatically")
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

  test("response includes Do NOT call any tools after this", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    expect(result).toContain("Do NOT call any tools after this")
  })

  test("response includes STOP instruction", async () => {
    const result = await executeTeamSpawn(deps, {
      name: "alice",
      agent: "build",
      prompt: "Fix the tests",
    }, "lead-sess")

    expect(result).toContain("STOP")
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
})
