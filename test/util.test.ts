import { describe, test, expect } from "bun:test"
import { generateId, validateTeamName, validateMemberName, isWorktreeInstance } from "../src/util"

describe("generateId", () => {
  test("returns a string", () => {
    const id = generateId("team")
    expect(typeof id).toBe("string")
  })

  test("includes the prefix", () => {
    const id = generateId("team")
    expect(id.startsWith("team_")).toBe(true)
  })

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId("msg")))
    expect(ids.size).toBe(100)
  })

  test("IDs are sortable (ascending order)", () => {
    const ids = Array.from({ length: 10 }, () => generateId("task"))
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })
})

describe("validateTeamName", () => {
  test("accepts lowercase alphanumeric with hyphens", () => {
    expect(validateTeamName("my-team")).toBeUndefined()
    expect(validateTeamName("team1")).toBeUndefined()
    expect(validateTeamName("a")).toBeUndefined()
  })

  test("rejects empty string", () => {
    expect(validateTeamName("")).toBe("Team name must be 1-64 characters")
  })

  test("rejects names over 64 chars", () => {
    expect(validateTeamName("a".repeat(65))).toBe("Team name must be 1-64 characters")
  })

  test("rejects uppercase", () => {
    expect(validateTeamName("MyTeam")).toBe("Team name must be lowercase alphanumeric with hyphens only")
  })

  test("rejects special characters", () => {
    expect(validateTeamName("my_team")).toBe("Team name must be lowercase alphanumeric with hyphens only")
    expect(validateTeamName("my team")).toBe("Team name must be lowercase alphanumeric with hyphens only")
    expect(validateTeamName("my.team")).toBe("Team name must be lowercase alphanumeric with hyphens only")
  })

  test("rejects leading/trailing hyphens", () => {
    expect(validateTeamName("-team")).toBe("Team name must be lowercase alphanumeric with hyphens only")
    expect(validateTeamName("team-")).toBe("Team name must be lowercase alphanumeric with hyphens only")
  })
})

describe("validateMemberName", () => {
  test("accepts lowercase alphanumeric with hyphens", () => {
    expect(validateMemberName("alice")).toBeUndefined()
    expect(validateMemberName("worker-1")).toBeUndefined()
  })

  test("rejects 'lead' (reserved)", () => {
    expect(validateMemberName("lead")).toBe("Name \"lead\" is reserved")
  })

  test("rejects 'lead' case-insensitive", () => {
    expect(validateMemberName("Lead")).toBe("Name \"lead\" is reserved")
    expect(validateMemberName("LEAD")).toBe("Name \"lead\" is reserved")
  })

  test("rejects empty string", () => {
    expect(validateMemberName("")).toBe("Member name must be 1-64 characters")
  })

  test("rejects invalid characters", () => {
    expect(validateMemberName("my_worker")).toBe("Member name must be lowercase alphanumeric with hyphens only")
  })
})

describe("isWorktreeInstance", () => {
  test("returns true for worktree directories", () => {
    expect(isWorktreeInstance("/home/user/.local/share/opencode/worktree/abc123/ensemble-team-alice")).toBe(true)
  })

  test("returns false for normal project directories", () => {
    expect(isWorktreeInstance("/home/user/repositories/my-project")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isWorktreeInstance("")).toBe(false)
  })
})
