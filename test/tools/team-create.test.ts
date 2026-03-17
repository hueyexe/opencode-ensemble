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
    expect(row.status).toBe("active")
  })

  test("rejects duplicate team name", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    await expect(executeTeamCreate(deps, { name: "my-team" }, "other-sess"))
      .rejects.toThrow("already exists")
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

  test("response string tells lead not to poll team_status", async () => {
    const result = await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    expect(result).toContain("Teammates will message you when done")
    expect(result).toContain("do not poll team_status")
  })
})
