import { describe, test, expect } from "bun:test"
import { ActivityBuffer, recordFromV2Event, recordFromToolBefore, recordFromToolAfter, type ActivityEntry } from "../src/activity"
import { MemberRegistry } from "../src/state"

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

  test("stores reasoning entries", () => {
    const buf = new ActivityBuffer()
    const entry = makeEntry({ type: "reasoning", reasoning: "I need to check the file first.", timestamp: 1000 })
    buf.record("s1", entry)
    const result = buf.getActivity("s1")
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("reasoning")
    expect(result[0]!.reasoning).toBe("I need to check the file first.")
  })

  test("stores file entries", () => {
    const buf = new ActivityBuffer()
    const entry = makeEntry({
      type: "file",
      filePath: "src/handler.ts",
      fileContent: "export function handle() {}",
      timestamp: 1000,
    })
    buf.record("s1", entry)
    const result = buf.getActivity("s1")
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("file")
    expect(result[0]!.filePath).toBe("src/handler.ts")
    expect(result[0]!.fileContent).toBe("export function handle() {}")
  })

  test("stores text entries with role", () => {
    const buf = new ActivityBuffer()
    buf.record("s1", makeEntry({ type: "text", text: "Fix the bug", role: "user", timestamp: 1000 }))
    buf.record("s1", makeEntry({ type: "text", text: "I'll start by reading the file.", role: "assistant", timestamp: 2000 }))
    const result = buf.getActivity("s1")
    expect(result).toHaveLength(2)
    expect(result[0]!.role).toBe("user")
    expect(result[1]!.role).toBe("assistant")
  })
})

describe("recordFromV2Event", () => {
  test("records shell.started event for registered member", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "alice", "sess-1")
    const buf = new ActivityBuffer()
    recordFromV2Event(
      { type: "session.next.shell.started", properties: { sessionID: "sess-1", command: "ls -la" } },
      registry,
      buf,
    )
    const entries = buf.getActivity("sess-1")
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("shell_command")
    expect(entries[0]!.command).toBe("ls -la")
  })

  test("records shell.ended event with exitCode for registered member", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "alice", "sess-1")
    const buf = new ActivityBuffer()
    recordFromV2Event(
      { type: "session.next.shell.ended", properties: { sessionID: "sess-1", exitCode: 0 } },
      registry,
      buf,
    )
    const entries = buf.getActivity("sess-1")
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("shell_command")
    expect(entries[0]!.exitCode).toBe(0)
  })

  test("records step.ended event with cost and tokens for registered member", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "alice", "sess-1")
    const buf = new ActivityBuffer()
    recordFromV2Event(
      { type: "session.next.step.ended", properties: { sessionID: "sess-1", cost: 0.05, tokens: { input: 100, output: 50 } } },
      registry,
      buf,
    )
    const entries = buf.getActivity("sess-1")
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("step")
    expect(entries[0]!.cost).toBe(0.05)
    expect(entries[0]!.tokensIn).toBe(100)
    expect(entries[0]!.tokensOut).toBe(50)
  })

  test("ignores tool.called/success/failed events (handled by tool.execute hooks)", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "alice", "sess-1")
    const buf = new ActivityBuffer()
    recordFromV2Event(
      { type: "session.next.tool.called", properties: { sessionID: "sess-1", tool: "edit" } },
      registry,
      buf,
    )
    recordFromV2Event(
      { type: "session.next.tool.success", properties: { sessionID: "sess-1", content: "ok" } },
      registry,
      buf,
    )
    recordFromV2Event(
      { type: "session.next.tool.failed", properties: { sessionID: "sess-1", error: "oops" } },
      registry,
      buf,
    )
    expect(buf.getActivity("sess-1")).toHaveLength(0)
  })

  test("does not record for non-member sessions", () => {
    const registry = new MemberRegistry()
    const buf = new ActivityBuffer()
    recordFromV2Event(
      { type: "session.next.shell.started", properties: { sessionID: "unknown", command: "ls" } },
      registry,
      buf,
    )
    expect(buf.getActivity("unknown")).toHaveLength(0)
  })

  test("does not record when sessionID is missing", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "alice", "sess-1")
    const buf = new ActivityBuffer()
    recordFromV2Event(
      { type: "session.next.shell.started", properties: {} },
      registry,
      buf,
    )
    expect(buf.has("sess-1")).toBe(false)
  })
})

describe("recordFromToolBefore", () => {
  test("records tool_call for registered member", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "bob", "sess-2")
    const buf = new ActivityBuffer()
    recordFromToolBefore({ sessionID: "sess-2", tool: "edit" }, registry, buf)
    const entries = buf.getActivity("sess-2")
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe("tool_call")
    expect(entries[0]!.tool).toBe("edit")
  })

  test("does not record for non-member sessions", () => {
    const registry = new MemberRegistry()
    const buf = new ActivityBuffer()
    recordFromToolBefore({ sessionID: "sess-unknown", tool: "edit" }, registry, buf)
    expect(buf.getActivity("sess-unknown")).toHaveLength(0)
  })
})

describe("recordFromToolAfter", () => {
  test("records tool_result with title and output for registered member", () => {
    const registry = new MemberRegistry()
    registry.register("team-1", "bob", "sess-2")
    const buf = new ActivityBuffer()
    recordFromToolBefore({ sessionID: "sess-2", tool: "read" }, registry, buf)
    recordFromToolAfter(
      { sessionID: "sess-2", tool: "read" },
      { title: "src/index.ts", output: "file contents here" },
      registry,
      buf,
    )
    const entries = buf.getActivity("sess-2")
    expect(entries).toHaveLength(2)
    expect(entries[0]!.type).toBe("tool_call")
    expect(entries[1]!.type).toBe("tool_result")
    expect(entries[1]!.tool).toBe("read")
    expect(entries[1]!.title).toBe("src/index.ts")
    expect(entries[1]!.output).toBe("file contents here")
  })

  test("does not record for non-member sessions", () => {
    const registry = new MemberRegistry()
    const buf = new ActivityBuffer()
    recordFromToolAfter(
      { sessionID: "sess-unknown", tool: "edit" },
      { title: "foo.ts", output: "bar" },
      registry,
      buf,
    )
    expect(buf.getActivity("sess-unknown")).toHaveLength(0)
  })
})
