import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { requireLead, requireTeamMember, requireCanPurgeArchivedTeams } from "../../src/tools/shared"

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

describe("requireCanPurgeArchivedTeams", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
  })

  test("allows a main session that is not part of an active team", () => {
    expect(() => requireCanPurgeArchivedTeams(deps, "main-sess")).not.toThrow()
  })

  test("allows the lead of an active team", () => {
    insertTeam(deps.db, "t1", "my-team", "lead-sess")

    expect(() => requireCanPurgeArchivedTeams(deps, "lead-sess")).not.toThrow()
  })

  test("rejects an active team member", () => {
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")

    expect(() => requireCanPurgeArchivedTeams(deps, "sess-alice")).toThrow("Team members cannot purge archived teams")
  })

  test("rejects descendants of active team sessions", () => {
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.tracker.track("child-sess", "sess-alice")

    expect(() => requireCanPurgeArchivedTeams(deps, "child-sess")).toThrow("Sub-agents cannot purge archived teams")
  })

  test("rejects descendants of main sessions", () => {
    deps.tracker.track("child-sess", "main-sess")

    expect(() => requireCanPurgeArchivedTeams(deps, "child-sess")).toThrow("Sub-agents cannot purge archived teams")
  })

  test("rejects descendants even if they lead their own active team", () => {
    deps.tracker.track("child-sess", "main-sess")
    insertTeam(deps.db, "t1", "child-team", "child-sess")

    expect(() => requireCanPurgeArchivedTeams(deps, "child-sess")).toThrow("Sub-agents cannot purge archived teams")
  })
})
