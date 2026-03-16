import { describe, test, expect, beforeEach } from "bun:test"
import { MemberRegistry, DescendantTracker } from "../src/state"

describe("MemberRegistry", () => {
  let registry: MemberRegistry

  beforeEach(() => {
    registry = new MemberRegistry()
  })

  test("register and lookup by sessionID", () => {
    registry.register("team1", "alice", "sess-1")
    expect(registry.getBySession("sess-1")).toEqual({
      teamId: "team1",
      memberName: "alice",
      sessionId: "sess-1",
    })
  })

  test("register and lookup by name", () => {
    registry.register("team1", "alice", "sess-1")
    expect(registry.getByName("team1", "alice")).toEqual({
      teamId: "team1",
      memberName: "alice",
      sessionId: "sess-1",
    })
  })

  test("returns undefined for unknown sessionID", () => {
    expect(registry.getBySession("unknown")).toBeUndefined()
  })

  test("returns undefined for unknown name", () => {
    expect(registry.getByName("team1", "unknown")).toBeUndefined()
  })

  test("lists all members for a team", () => {
    registry.register("team1", "alice", "sess-1")
    registry.register("team1", "bob", "sess-2")
    registry.register("team2", "carol", "sess-3")
    const members = registry.listByTeam("team1")
    expect(members).toHaveLength(2)
    expect(members.map(m => m.memberName).sort()).toEqual(["alice", "bob"])
  })

  test("unregister removes member", () => {
    registry.register("team1", "alice", "sess-1")
    registry.unregister("sess-1")
    expect(registry.getBySession("sess-1")).toBeUndefined()
    expect(registry.getByName("team1", "alice")).toBeUndefined()
  })

  test("unregisterTeam removes all members for a team", () => {
    registry.register("team1", "alice", "sess-1")
    registry.register("team1", "bob", "sess-2")
    registry.register("team2", "carol", "sess-3")
    registry.unregisterTeam("team1")
    expect(registry.getBySession("sess-1")).toBeUndefined()
    expect(registry.getBySession("sess-2")).toBeUndefined()
    expect(registry.getBySession("sess-3")).toBeTruthy()
  })

  test("isTeamSession returns true for registered sessions", () => {
    registry.register("team1", "alice", "sess-1")
    expect(registry.isTeamSession("sess-1")).toBe(true)
    expect(registry.isTeamSession("unknown")).toBe(false)
  })
})

describe("DescendantTracker", () => {
  let tracker: DescendantTracker

  beforeEach(() => {
    tracker = new DescendantTracker()
  })

  test("track parent-child relationship", () => {
    tracker.track("child-1", "parent-1")
    expect(tracker.getParent("child-1")).toBe("parent-1")
  })

  test("returns undefined for untracked session", () => {
    expect(tracker.getParent("unknown")).toBeUndefined()
  })

  test("isDescendantOf walks the parent chain", () => {
    tracker.track("child", "parent")
    tracker.track("grandchild", "child")
    expect(tracker.isDescendantOf("grandchild", new Set(["parent"]))).toBe(true)
  })

  test("isDescendantOf returns false for unrelated sessions", () => {
    tracker.track("child", "parent-a")
    expect(tracker.isDescendantOf("child", new Set(["parent-b"]))).toBe(false)
  })

  test("isDescendantOf respects max depth", () => {
    // Build a chain of depth 15
    for (let i = 1; i <= 15; i++) {
      tracker.track(`s${i}`, `s${i - 1}`)
    }
    // Default max depth is 10, so s15 should NOT find s0 as ancestor
    expect(tracker.isDescendantOf("s15", new Set(["s0"]))).toBe(false)
    // But s10 should find s0
    expect(tracker.isDescendantOf("s10", new Set(["s0"]))).toBe(true)
  })

  test("remove cleans up a session", () => {
    tracker.track("child", "parent")
    tracker.remove("child")
    expect(tracker.getParent("child")).toBeUndefined()
  })
})
