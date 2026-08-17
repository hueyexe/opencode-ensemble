import { describe, test, expect } from "bun:test"
import { ProgressTracker } from "../src/progress"

describe("ProgressTracker", () => {
  test("recordStep stores entries", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 100)
    pt.recordStep("s1", 200)
    expect(pt.isTokenStalled("s1", 2, 50)).toBe(false) // both above 50
  })

  test("ring buffer evicts oldest entries", () => {
    const pt = new ProgressTracker(3)
    pt.recordStep("s1", 1000) // will be evicted
    pt.recordStep("s1", 10)
    pt.recordStep("s1", 10)
    pt.recordStep("s1", 10)
    // Only last 3 remain (all 10), so stalled at threshold 500
    expect(pt.isTokenStalled("s1", 3, 500)).toBe(true)
  })

  test("isTokenStalled returns false with fewer than minSteps", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 10)
    expect(pt.isTokenStalled("s1", 3, 500)).toBe(false)
  })

  test("isTokenStalled returns true when all recent steps below threshold", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 100)
    pt.recordStep("s1", 200)
    pt.recordStep("s1", 50)
    expect(pt.isTokenStalled("s1", 3, 500)).toBe(true)
  })

  test("isTokenStalled returns false when any recent step above threshold", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 100)
    pt.recordStep("s1", 600)
    pt.recordStep("s1", 50)
    expect(pt.isTokenStalled("s1", 3, 500)).toBe(false)
  })

  test("isTokenStalled returns false for unknown session", () => {
    const pt = new ProgressTracker()
    expect(pt.isTokenStalled("unknown", 3, 500)).toBe(false)
  })

  test("isTimeStalled returns false for brand new session (no steps)", () => {
    const pt = new ProgressTracker()
    expect(pt.isTimeStalled("s1", 1000)).toBe(false)
  })

  test("isTimeStalled returns false when recent activity exists", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 100)
    pt.recordMessage("s1")
    expect(pt.isTimeStalled("s1", 180_000)).toBe(false)
  })

  test("isTimeStalled uses first step time as baseline when no messages", () => {
    const pt = new ProgressTracker()
    // Manually inject an old step record
    pt.recordStep("s1", 100)
    // With threshold of 0ms, any step in the past should be stalled
    expect(pt.isTimeStalled("s1", 0)).toBe(true)
  })

  // --- Busy-transition baseline (regression: first-action stall detection gap) ---
  // isTimeStalled previously bailed out with `false` whenever a session had zero
  // recorded steps, regardless of how long it had been busy. A teammate whose
  // entire task is one long-running tool call (e.g. a slow build, sleep, or test
  // run as its FIRST action) never accumulates a step record until that call
  // returns — meaning the "sane" nudge+notify stall path never fired for exactly
  // this pattern, even well past stallThresholdMs. recordBusyStart() gives
  // isTimeStalled a baseline independent of step records.

  test("isTimeStalled returns true for a busy member with zero step records", () => {
    const pt = new ProgressTracker()
    pt.recordBusyStart("s1")
    expect(pt.isTimeStalled("s1", 0)).toBe(true)
  })

  test("isTimeStalled still returns false with no busy signal and no steps", () => {
    const pt = new ProgressTracker()
    expect(pt.isTimeStalled("s1", 0)).toBe(false)
  })

  test("isTimeStalled prefers a later step timestamp over an earlier busy-start", () => {
    const pt = new ProgressTracker()
    pt.recordBusyStart("s1")
    pt.recordStep("s1", 100) // more recent activity signal than busy-start
    pt.recordMessage("s1") // clears nothing relevant; just the most recent signal
    expect(pt.isTimeStalled("s1", 180_000)).toBe(false)
  })

  test("remove cleans up busySince state", () => {
    const pt = new ProgressTracker()
    pt.recordBusyStart("s1")
    pt.remove("s1")
    expect(pt.isTimeStalled("s1", 0)).toBe(false)
  })

  test("recordMessage clears stall report", () => {
    const pt = new ProgressTracker()
    pt.markReported("s1")
    expect(pt.isReported("s1")).toBe(true)
    pt.recordMessage("s1")
    expect(pt.isReported("s1")).toBe(false)
  })

  test("recordTaskComplete clears stall report", () => {
    const pt = new ProgressTracker()
    pt.markReported("s1")
    pt.recordTaskComplete("s1")
    expect(pt.isReported("s1")).toBe(false)
  })

  test("markReported / isReported / clearReport lifecycle", () => {
    const pt = new ProgressTracker()
    expect(pt.isReported("s1")).toBe(false)
    pt.markReported("s1")
    expect(pt.isReported("s1")).toBe(true)
    pt.clearReport("s1")
    expect(pt.isReported("s1")).toBe(false)
  })

  test("remove cleans up all state", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 100)
    pt.recordMessage("s1")
    pt.recordTaskComplete("s1")
    pt.markReported("s1")
    pt.remove("s1")
    expect(pt.isTokenStalled("s1", 1, 500)).toBe(false)
    expect(pt.isTimeStalled("s1", 0)).toBe(false)
    expect(pt.isReported("s1")).toBe(false)
  })

  test("remove does not affect other sessions", () => {
    const pt = new ProgressTracker()
    pt.recordStep("s1", 10)
    pt.recordStep("s2", 10)
    pt.remove("s1")
    expect(pt.isTokenStalled("s2", 1, 500)).toBe(true)
  })

  // --- Chatty detection ---

  test("isChatty returns false with no peer messages", () => {
    const pt = new ProgressTracker()
    expect(pt.isChatty("s1", 5, 300_000)).toBe(false)
  })

  test("isChatty returns false below limit", () => {
    const pt = new ProgressTracker()
    pt.recordPeerMessage("s1")
    pt.recordPeerMessage("s1")
    pt.recordPeerMessage("s1")
    expect(pt.isChatty("s1", 5, 300_000)).toBe(false)
  })

  test("isChatty returns true at limit", () => {
    const pt = new ProgressTracker()
    for (let i = 0; i < 5; i++) pt.recordPeerMessage("s1")
    expect(pt.isChatty("s1", 5, 300_000)).toBe(true)
  })

  test("isChatty returns false when limit is 0 (disabled)", () => {
    const pt = new ProgressTracker()
    for (let i = 0; i < 10; i++) pt.recordPeerMessage("s1")
    expect(pt.isChatty("s1", 0, 300_000)).toBe(false)
  })

  test("markChattyReported / isChattyReported / clearChattyReport lifecycle", () => {
    const pt = new ProgressTracker()
    expect(pt.isChattyReported("s1")).toBe(false)
    pt.markChattyReported("s1")
    expect(pt.isChattyReported("s1")).toBe(true)
    pt.clearChattyReport("s1")
    expect(pt.isChattyReported("s1")).toBe(false)
  })

  test("remove cleans up chatty state", () => {
    const pt = new ProgressTracker()
    for (let i = 0; i < 5; i++) pt.recordPeerMessage("s1")
    pt.markChattyReported("s1")
    pt.remove("s1")
    expect(pt.isChatty("s1", 5, 300_000)).toBe(false)
    expect(pt.isChattyReported("s1")).toBe(false)
  })
})
