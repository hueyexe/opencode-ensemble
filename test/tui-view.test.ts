import { describe, expect, test } from "bun:test"
import {
  getLayoutWidth,
  isPrimaryLinkActivation,
  summarizeMembers,
  type SidebarMember,
} from "../src/tui-view"

function member(name: string, status: string): SidebarMember {
  return { name, status }
}

describe("tui-view helpers (issue #36)", () => {
  test("summarizeMembers counts by status and lists names", () => {
    const summary = summarizeMembers("alpha", [
      member("alice", "busy"),
      member("bob", "ready"),
      member("cara", "busy"),
    ])
    expect(summary).toMatchObject({ team: "alpha", working: 2, idle: 1, total: 3 })
    expect(summary.lines.join("\n")).toContain("alice")
    expect(summary.lines.join("\n")).toContain("bob")
  })

  test("empty team renders a placeholder line", () => {
    const summary = summarizeMembers("alpha", [])
    expect(summary.total).toBe(0)
    expect(summary.lines.length).toBe(1)
  })

  test("terminal states group as done", () => {
    const summary = summarizeMembers("alpha", [
      member("alice", "shutdown"),
      member("bob", "error"),
    ])
    expect(summary).toMatchObject({ working: 0, idle: 0, total: 2 })
  })

  test("dashboard links activate only on an un-dragged primary click", () => {
    expect(isPrimaryLinkActivation({ button: 0 })).toBe(true)
    expect(isPrimaryLinkActivation({ button: 1 })).toBe(false)
    expect(isPrimaryLinkActivation({ button: 0, isDragging: true })).toBe(false)
  })

  test("reads widths from both OpenTUI layout APIs", () => {
    expect(getLayoutWidth({ getLayout: () => ({ width: 42 }) })).toBe(42)
    expect(
      getLayoutWidth({ getLayoutNode: () => ({ getComputedWidth: () => 64 }) }),
    ).toBe(64)
    expect(getLayoutWidth(undefined)).toBeUndefined()
  })
})
