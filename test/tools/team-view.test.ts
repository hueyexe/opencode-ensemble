import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamView } from "../../src/tools/team-view"

describe("team_view", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("calls selectSession with the member's session ID", async () => {
    const result = await executeTeamView(deps, { member: "alice" }, "lead-sess")
    expect(result).toContain("alice")

    const selectCalls = deps.client.calls.filter(c => c.method === "tui.selectSession")
    expect(selectCalls).toHaveLength(1)
    expect((selectCalls[0]!.args[0] as Record<string, string>).sessionID).toBe("sess-alice")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamView(deps, { member: "alice" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("rejects if member not found", async () => {
    await expect(executeTeamView(deps, { member: "unknown" }, "lead-sess"))
      .rejects.toThrow("not found")
  })

  test("works for teammates viewing other teammates", async () => {
    insertMember(deps.db, "t1", "bob", "sess-bob", "ready", "idle")
    deps.registry.register("t1", "bob", "sess-bob")

    const result = await executeTeamView(deps, { member: "alice" }, "sess-bob")
    expect(result).toContain("alice")
  })
})
