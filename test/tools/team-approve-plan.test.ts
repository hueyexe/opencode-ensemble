import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamApprovePlan } from "../../src/tools/team-approve-plan"

describe("team_approve_plan", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("approves a plan and sends message to teammate", async () => {
    const result = await executeTeamApprovePlan(deps, {
      member: "alice",
      approved: true,
      feedback: "Looks good",
    }, "lead-sess")

    expect(result).toContain("approved")
    expect(result).toContain("alice")
    expect(result).toContain("Looks good")

    // Check promptAsync was called on alice's session
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)

    // Check message was stored
    const msgs = deps.db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.from_name).toBe("lead")
    expect(msgs[0]!.to_name).toBe("alice")
  })

  test("rejects a plan with feedback", async () => {
    const result = await executeTeamApprovePlan(deps, {
      member: "alice",
      approved: false,
      feedback: "Needs more detail",
    }, "lead-sess")

    expect(result).toContain("rejected")
    expect(result).toContain("Needs more detail")
  })

  test("rejects if caller is not the lead", async () => {
    await expect(executeTeamApprovePlan(deps, {
      member: "alice",
      approved: true,
    }, "sess-alice")).rejects.toThrow("Only the team lead")
  })

  test("rejects if member not found", async () => {
    await expect(executeTeamApprovePlan(deps, {
      member: "unknown",
      approved: true,
    }, "lead-sess")).rejects.toThrow("not found")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamApprovePlan(deps, {
      member: "alice",
      approved: true,
    }, "random-sess")).rejects.toThrow("not in a team")
  })
})
