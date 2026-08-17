import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam } from "../helpers"
import { executeTeamCreate } from "../../src/tools/team-create"
import type { ToolDeps } from "../../src/types"

describe("team_create", () => {
  let deps: ToolDeps

  beforeEach(() => {
    deps = setupDeps()
  })

  test("creates a team and returns confirmation", async () => {
    const result = await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    expect(result).toContain("my-team")
    expect(result).toContain("created")

    const row = deps.db.query("SELECT * FROM team WHERE name = ?").get("my-team") as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.lead_session_id).toBe("lead-sess")
    expect(row.project_id).toBe("/tmp/test-project")
    expect(row.status).toBe("active")

    const project = deps.db.query("SELECT id, name, path FROM project WHERE id = ?").get("/tmp/test-project") as Record<string, unknown>
    expect(project.path).toBe("/tmp/test-project")
    expect(typeof project.name).toBe("string")
    expect(project.name).not.toBe("test-project")
  })

  test("uses explicit project name on first team in a project", async () => {
    await executeTeamCreate(deps, { name: "my-team", project_name: "silver-river" }, "lead-sess")

    const project = deps.db.query("SELECT name FROM project WHERE id = ?").get("/tmp/test-project") as { name: string }
    expect(project.name).toBe("silver-river")
  })

  test("rejects invalid explicit project name", async () => {
    await expect(executeTeamCreate(deps, { name: "my-team", project_name: "Silver River" }, "lead-sess"))
      .rejects.toThrow("Project name")
  })

  test("rejects duplicate team name", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    await expect(executeTeamCreate(deps, { name: "my-team" }, "other-sess"))
      .rejects.toThrow("already exists")
  })

  test("reclaims a team name whose lead session no longer exists (orphan reconciliation)", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "dead-lead-sess")
    // Simulate the lead session having been deleted externally (e.g. via OpenCode's
    // own session UI, not through team_cleanup) -- client.session.get throws for it.
    const originalGet = deps.client.session.get.bind(deps.client.session)
    deps.client.session.get = async (options) => {
      if (options.sessionID === "dead-lead-sess") throw new Error("session not found")
      return originalGet(options)
    }

    // A brand new session should be able to reclaim the name instead of hitting
    // "already exists" against a team nobody can ever be lead of again.
    const result = await executeTeamCreate(deps, { name: "my-team" }, "new-lead-sess")
    expect(result).toContain("created")

    const rows = deps.db.query("SELECT lead_session_id, status FROM team WHERE name = ? ORDER BY time_created")
      .all("my-team") as Array<{ lead_session_id: string; status: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]!.lead_session_id).toBe("dead-lead-sess")
    expect(rows[0]!.status).toBe("archived")
    expect(rows[1]!.lead_session_id).toBe("new-lead-sess")
    expect(rows[1]!.status).toBe("active")
  })

  test("still rejects duplicate name when the existing lead session is genuinely alive", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    // Default mock client.session.get always resolves -- lead-sess reads as alive.
    await expect(executeTeamCreate(deps, { name: "my-team" }, "other-sess")).rejects.toThrow("already exists")
  })

  test("allows same active team name in different projects", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")

    const otherDeps = setupDeps(deps.db)
    otherDeps.directory = "/tmp/other-project"

    await executeTeamCreate(otherDeps, { name: "my-team" }, "other-sess")

    const rows = deps.db.query("SELECT name, project_id FROM team WHERE name = ? ORDER BY project_id").all("my-team") as Array<{ name: string; project_id: string }>
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.project_id)).toEqual(["/tmp/other-project", "/tmp/test-project"])
  })

  test("rejects if session already leads a team", async () => {
    await executeTeamCreate(deps, { name: "team-a" }, "lead-sess")
    await expect(executeTeamCreate(deps, { name: "team-b" }, "lead-sess"))
      .rejects.toThrow("already")
  })

  test("rejects invalid team name", async () => {
    await expect(executeTeamCreate(deps, { name: "My Team!" }, "lead-sess"))
      .rejects.toThrow()
  })

  test("rejects empty team name", async () => {
    await expect(executeTeamCreate(deps, { name: "" }, "lead-sess"))
      .rejects.toThrow()
  })

  test("response is clean without LLM instructions", async () => {
    const result = await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    expect(result).toContain("team_spawn")
    expect(result).not.toContain("STOP")
    expect(result).not.toContain("do NOT call")
    expect(result).not.toContain("do not poll")
    expect(result).not.toContain("woken automatically")
  })
})
