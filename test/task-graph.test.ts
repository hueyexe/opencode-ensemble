import { describe, test, expect } from "bun:test"
import { parseTaskDependencies, inspectTaskGraph, depthForDependencies } from "../src/task-graph"
import type { TaskGraphNode } from "../src/task-graph"

function node(id: string, dependsOn: string[] = [], status = "pending"): TaskGraphNode {
  return { id, dependsOn, status }
}

describe("parseTaskDependencies", () => {
  test("parses JSON arrays and deduplicates", () => {
    expect(parseTaskDependencies('["a","b","a"]')).toEqual(["a", "b"])
  })

  test("returns an empty array for null/empty", () => {
    expect(parseTaskDependencies(null)).toEqual([])
    expect(parseTaskDependencies("")).toEqual([])
    expect(parseTaskDependencies("[]")).toEqual([])
  })

  test("tolerates a legacy plain string and malformed JSON", () => {
    expect(parseTaskDependencies("task_a")).toEqual(["task_a"])
    expect(parseTaskDependencies("not json {{{")).toEqual(["not json {{{"])
    expect(parseTaskDependencies('{"not":"an array"}')).toEqual([])
  })
})

describe("inspectTaskGraph", () => {
  test("assigns depth 1 to roots and N to a chain", () => {
    const graph = inspectTaskGraph([node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["c"])])
    expect(graph.depthByTask.get("a")).toBe(1)
    expect(graph.depthByTask.get("b")).toBe(2)
    expect(graph.depthByTask.get("c")).toBe(3)
    expect(graph.depthByTask.get("d")).toBe(4)
    expect(graph.cyclic).toEqual([])
  })

  test("uses the longest prerequisite path for a diamond", () => {
    const graph = inspectTaskGraph([
      node("a"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ])
    expect(graph.depthByTask.get("d")).toBe(3)
  })

  test("reports cycles instead of hanging", () => {
    const graph = inspectTaskGraph([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])])
    expect(graph.cyclic.sort()).toEqual(["a", "b", "c"])
    expect(graph.depthByTask.size).toBe(0)
  })

  test("reports missing dependency IDs", () => {
    const graph = inspectTaskGraph([node("a", ["missing"]), node("b")])
    expect(graph.missing).toEqual(["missing"])
    expect(graph.depthByTask.get("a")).toBe(1)
  })

  test("activeOnly treats completed/cancelled prerequisites as resolved roots", () => {
    const tasks = [
      node("a", [], "completed"),
      node("b", ["a"], "pending"),
      node("c", ["b"], "cancelled"),
      node("d", ["b", "c"], "pending"),
    ]
    expect(inspectTaskGraph(tasks).depthByTask.get("d")).toBe(4)
    const active = inspectTaskGraph(tasks, { activeOnly: true })
    // Resolved tasks contribute depth 0, so follow-up work starts at 1.
    expect(active.depthByTask.get("a")).toBe(0)
    expect(active.depthByTask.get("b")).toBe(1)
    expect(active.depthByTask.get("c")).toBe(0)
    expect(active.depthByTask.get("d")).toBe(2)
  })

  test("handles a 1,000-node chain iteratively", () => {
    const nodes = Array.from({ length: 1000 }, (_, index) =>
      node(`t${index}`, index === 0 ? [] : [`t${index - 1}`]))
    const graph = inspectTaskGraph(nodes)
    expect(graph.depthByTask.get("t999")).toBe(1000)
    expect(graph.cyclic).toEqual([])
  })
})

describe("depthForDependencies", () => {
  const graph = inspectTaskGraph([node("a"), node("b", ["a"]), node("c", ["b"])])

  test("a new root is depth 1", () => {
    expect(depthForDependencies([], graph)).toBe(1)
  })

  test("a new task is one deeper than its deepest prerequisite", () => {
    expect(depthForDependencies(["a"], graph)).toBe(2)
    expect(depthForDependencies(["c"], graph)).toBe(4)
    expect(depthForDependencies(["a", "c"], graph)).toBe(4)
  })
})
