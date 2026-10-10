import { describe, expect, test } from "bun:test"
import { summarizeMembers, formatSidebarTask, type SidebarMember } from "../src/tui-view"

function member(name: string, status: string): SidebarMember {
  return { name, status }
}

describe("tui-view helpers (issue #36)", () => {
  test("open task shows pending description and unassigned owner", () => {
    expect(formatSidebarTask({ id: "task1", content: "Criar src/greeting.ts", status: "pending", assignee: null })).toEqual([
      "□ [pending] Criar src/greeting.ts", "  responsável: não atribuído",
    ])
  })

  test("open task shows its state and assigned owner", () => {
    expect(formatSidebarTask({ id: "task2", content: "Implementar", status: "in_progress", assignee: "calc-dev" })).toEqual([
      "□ [in_progress] Implementar", "  responsável: calc-dev",
    ])
    expect(formatSidebarTask({ id: "task3", content: "Revisar", status: "blocked", assignee: null })[0]).toBe("□ [blocked] Revisar")
  })

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
})
