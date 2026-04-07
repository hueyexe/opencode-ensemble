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
})
