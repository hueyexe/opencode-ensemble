import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { requireLead, requireTeamMember } from "../../src/tools/shared"

describe("requireLead", () => {
  let deps: ReturnType<typeof setupDeps>
  beforeEach(() => { deps = setupDeps(); insertTeam(deps.db, "t1", "my-team", "lead-sess") })

  test("returns team info for the lead session", () => {
    const result = requireLead(deps, "lead-sess")
    expect(result.teamId).toBe("t1")
    expect(result.teamName).toBe("my-team")
  })
  test("throws if session is not in a team", () => {
    expect(() => requireLead(deps, "random-sess")).toThrow("not in a team")
  })
  test("throws if session is a member, not the lead", () => {
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
    expect(() => requireLead(deps, "sess-alice")).toThrow("Only the team lead")
  })
})

describe("requireTeamMember", () => {
  let deps: ReturnType<typeof setupDeps>
  beforeEach(() => { deps = setupDeps(); insertTeam(deps.db, "t1", "my-team", "lead-sess") })

  test("returns team info for the lead", () => {
    const result = requireTeamMember(deps, "lead-sess")
    expect(result.teamId).toBe("t1")
    expect(result.role).toBe("lead")
  })
  test("returns team info for a member", () => {
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
    const result = requireTeamMember(deps, "sess-alice")
    expect(result.role).toBe("member")
    expect(result.memberName).toBe("alice")
  })
  test("throws if session is not in a team", () => {
    expect(() => requireTeamMember(deps, "random-sess")).toThrow("not in a team")
  })
})
