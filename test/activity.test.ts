import { describe, test, expect } from "bun:test"
import { ActivityBuffer, type ActivityEntry } from "../src/activity"

function makeEntry(
  partial: Partial<ActivityEntry> & { timestamp: number },
): ActivityEntry {
  return {
    type: "tool_call",
    ...partial,
  }
}

describe("ActivityBuffer", () => {
  test("record stores an entry and getActivity returns it", () => {
    const buf = new ActivityBuffer()
    const entry = makeEntry({ type: "tool_call", tool: "edit", timestamp: 1000 })
    buf.record("s1", entry)
    expect(buf.getActivity("s1")).toEqual([entry])
  })

  test("getActivity returns entries in chronological order (oldest first)", () => {
    const buf = new ActivityBuffer()
    const e1 = makeEntry({ type: "step", timestamp: 1000 })
    const e2 = makeEntry({ type: "step", timestamp: 2000 })
    const e3 = makeEntry({ type: "step", timestamp: 3000 })
    buf.record("s1", e1)
    buf.record("s1", e2)
    buf.record("s1", e3)
    expect(buf.getActivity("s1")).toEqual([e1, e2, e3])
  })

  test("buffer evicts oldest entries when maxPerSession is exceeded", () => {
    const buf = new ActivityBuffer({ maxPerSession: 3 })
    const e1 = makeEntry({ type: "tool_call", timestamp: 1000 })
    const e2 = makeEntry({ type: "tool_call", timestamp: 2000 })
    const e3 = makeEntry({ type: "tool_call", timestamp: 3000 })
    const e4 = makeEntry({ type: "tool_call", timestamp: 4000 })
    buf.record("s1", e1)
    buf.record("s1", e2)
    buf.record("s1", e3)
    buf.record("s1", e4)
    expect(buf.getActivity("s1")).toEqual([e2, e3, e4])
  })

  test("remove clears entries for a session", () => {
    const buf = new ActivityBuffer()
    buf.record("s1", makeEntry({ type: "tool_call", timestamp: 1000 }))
    buf.record("s1", makeEntry({ type: "tool_call", timestamp: 2000 }))
    buf.remove("s1")
    expect(buf.getActivity("s1")).toEqual([])
    expect(buf.has("s1")).toBe(false)
  })

  test("has returns true when entries exist, false when empty", () => {
    const buf = new ActivityBuffer()
    expect(buf.has("s1")).toBe(false)
    buf.record("s1", makeEntry({ type: "tool_call", timestamp: 1000 }))
    expect(buf.has("s1")).toBe(true)
  })

  test("getActivity with limit returns only the N most recent entries", () => {
    const buf = new ActivityBuffer()
    const e1 = makeEntry({ type: "tool_call", timestamp: 1000 })
    const e2 = makeEntry({ type: "tool_call", timestamp: 2000 })
    const e3 = makeEntry({ type: "tool_call", timestamp: 3000 })
    const e4 = makeEntry({ type: "tool_call", timestamp: 4000 })
    const e5 = makeEntry({ type: "tool_call", timestamp: 5000 })
    buf.record("s1", e1)
    buf.record("s1", e2)
    buf.record("s1", e3)
    buf.record("s1", e4)
    buf.record("s1", e5)
    expect(buf.getActivity("s1", 3)).toEqual([e3, e4, e5])
  })

  test("getActivity for unknown session returns empty array", () => {
    const buf = new ActivityBuffer()
    expect(buf.getActivity("unknown")).toEqual([])
  })

  test("default maxPerSession is 100", () => {
    const buf = new ActivityBuffer()
    for (let i = 0; i < 120; i++) {
      buf.record("s1", makeEntry({ type: "tool_call", timestamp: i }))
    }
    const entries = buf.getActivity("s1")
    expect(entries.length).toBe(100)
    expect(entries[0]?.timestamp).toBe(20)
    expect(entries[entries.length - 1]?.timestamp).toBe(119)
  })

  test("custom maxPerSession works via constructor option", () => {
    const buf = new ActivityBuffer({ maxPerSession: 5 })
    for (let i = 0; i < 10; i++) {
      buf.record("s1", makeEntry({ type: "tool_call", timestamp: i }))
    }
    const entries = buf.getActivity("s1")
    expect(entries.length).toBe(5)
    expect(entries[0]?.timestamp).toBe(5)
    expect(entries[entries.length - 1]?.timestamp).toBe(9)
  })

  test("multiple sessions are independent", () => {
    const buf = new ActivityBuffer()
    buf.record("s1", makeEntry({ type: "tool_call", tool: "edit", timestamp: 1000 }))
    buf.record("s2", makeEntry({ type: "shell_command", command: "ls", timestamp: 2000 }))
    buf.record("s1", makeEntry({ type: "tool_call", tool: "read", timestamp: 3000 }))
    buf.record("s2", makeEntry({ type: "shell_command", command: "pwd", timestamp: 4000 }))

    expect(buf.getActivity("s1")).toHaveLength(2)
    expect(buf.getActivity("s2")).toHaveLength(2)
    expect(buf.getActivity("s1")[0]?.tool).toBe("edit")
    expect(buf.getActivity("s2")[0]?.command).toBe("ls")

    buf.remove("s1")
    expect(buf.has("s1")).toBe(false)
    expect(buf.has("s2")).toBe(true)
    expect(buf.getActivity("s2")).toHaveLength(2)
  })
})
