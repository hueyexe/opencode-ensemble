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
})
