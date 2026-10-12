import { describe, expect, test } from "bun:test"
import { DASHBOARD_JS_GRAPH_LAYOUT } from "../src/dashboard-js-graph-layout"

interface Task { id: string; content: string; status: string; assignee: string | null; dependsOn: string[] }
interface Layout {
  nodes: { task: Task; x: number; y: number }[]
  edges: { from: string; to: string }[]
  missing: { taskId: string; dependencyId: string }[]
  cyclic: string[]
  width: number
  height: number
}
const layout = new Function(`${DASHBOARD_JS_GRAPH_LAYOUT};return graphLayout`)() as (tasks: readonly Task[]) => Layout
const task = (id: string, dependsOn: string[] = []): Task => ({ id, content: id, status: "pending", assignee: null, dependsOn })

describe("dependency graph layout", () => {
  test("a chain flows left to right even when tasks arrive in reverse order", () => {
    const result = layout([task("c", ["b"]), task("b", ["a"]), task("a")])
    const xs = new Map(result.nodes.map(n => [n.task.id, n.x]))
    expect(result.nodes).toHaveLength(3)
    expect(xs.get("a")).toBeLessThan(xs.get("b")!)
    expect(xs.get("b")).toBeLessThan(xs.get("c")!)
    expect(result.edges).toEqual([{ from: "b", to: "c" }, { from: "a", to: "b" }])
  })

  test("fork and join have four arrows and non-overlapping branch cards", () => {
    const result = layout([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])])
    expect(result.edges).toHaveLength(4)
    const b = result.nodes.find(n => n.task.id === "b")!
    const c = result.nodes.find(n => n.task.id === "c")!
    expect(b.x).toBe(c.x)
    expect(c.y - b.y).toBeGreaterThanOrEqual(172)
    expect(result.width).toBeGreaterThan(result.nodes[3]!.x + 280)
    expect(result.height).toBeGreaterThan(c.y + 172)
  })

  test("disconnected tasks remain visible in stable input order", () => {
    const tasks = [task("z"), task("a"), task("m")]
    expect(layout(tasks).nodes.map(n => n.task.id)).toEqual(["z", "a", "m"])
    expect(layout(tasks)).toEqual(layout(tasks))
    expect(tasks.map(t => t.id)).toEqual(["z", "a", "m"])
  })

  test("empty input has finite dimensions and no graph elements", () => {
    const result = layout([])
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.cyclic).toEqual([])
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  test("missing IDs are reported while duplicate prerequisites produce one arrow", () => {
    const result = layout([task("a"), task("b", ["a", "a", "gone", "gone"])])
    expect(result.edges).toEqual([{ from: "a", to: "b" }])
    expect(result.missing).toEqual([{ taskId: "b", dependencyId: "gone" }])
    expect(result.nodes).toHaveLength(2)
    expect(result.cyclic).toEqual([])
  })

  test.each([
    { tasks: [task("a", ["b"]), task("b", ["a"])] },
    { tasks: [task("a", ["a"])] },
    { tasks: [task("a", ["b"]), task("b", ["a"]), task("downstream", ["b"])] },
  ])("cycles terminate and retain all unresolved tasks", ({ tasks }) => {
    const result = layout(tasks)
    expect(result.nodes).toHaveLength(tasks.length)
    expect(result.cyclic).toEqual(tasks.map(t => t.id))
    expect(result.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })

  test("prototype-like IDs are ordinary tasks", () => {
    const result = layout([task("__proto__"), task("constructor", ["__proto__"]), task("toString", ["constructor"])])
    expect(result.nodes).toHaveLength(3)
    expect(result.edges).toHaveLength(2)
    expect(result.missing).toEqual([])
    expect(result.cyclic).toEqual([])
  })

  test("a thousand-task chain does not recurse or drop tasks", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => task(String(i), i ? [String(i - 1)] : []))
    const result = layout(tasks)
    expect(result.nodes).toHaveLength(1000)
    expect(result.edges).toHaveLength(999)
    expect(result.nodes[999]!.x).toBeGreaterThan(result.nodes[0]!.x)
    expect(Number.isFinite(result.width)).toBe(true)
    expect(result.cyclic).toEqual([])
  })
})
