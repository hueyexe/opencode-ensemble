/** A task node as needed for dependency graph inspection. */
export interface TaskGraphNode {
  id: string
  status: string
  dependsOn: string[]
}

/** Result of inspecting a team's task dependency graph. */
export interface TaskGraphInfo {
  /** Longest-prerequisite-path depth per task (roots are 1). */
  depthByTask: Map<string, number>
  /** Tasks that are part of a dependency cycle. */
  cyclic: string[]
  /** Dependency IDs that do not resolve to a task in the graph. */
  missing: string[]
}

/**
 * Parse a `depends_on` column into a deduplicated list of task IDs.
 * Tolerates malformed/legacy values instead of throwing, so one bad row
 * cannot break task completion or graph rendering.
 */
export function parseTaskDependencies(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))]
    }
    if (typeof parsed === "string" && parsed.length > 0) return [parsed]
  } catch {
    // Legacy/hand-edited plain string.
    return [value]
  }
  return []
}

/** Options for graph inspection. */
export interface TaskGraphOptions {
  /**
   * Ignore edges whose prerequisite is already completed/cancelled. Use this
   * for depth-limit enforcement so finished work does not accumulate into a
   * lifetime chain that blocks follow-up tasks.
   */
  activeOnly?: boolean
}

/**
 * Inspect a task graph. Depth is the longest prerequisite path, with roots at
 * 1 (a four-task chain has depth 4). Cyclic/cycle-affected tasks are reported
 * and omitted from depthByTask so callers can reject additions that would
 * build on corrupt data.
 */
export function inspectTaskGraph(tasks: TaskGraphNode[], options: TaskGraphOptions = {}): TaskGraphInfo {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const deps = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  const missing = new Set<string>()

  tasks.forEach(task => {
    children.set(task.id, [])
    indegree.set(task.id, 0)
  })

  tasks.forEach(task => {
    const valid: string[] = []
    for (const depId of task.dependsOn) {
      const dependency = byId.get(depId)
      if (!dependency) {
        missing.add(depId)
        continue
      }
      if (options.activeOnly && (dependency.status === "completed" || dependency.status === "cancelled")) continue
      if (valid.includes(depId)) continue
      valid.push(depId)
      children.get(depId)?.push(task.id)
    }
    deps.set(task.id, valid)
    indegree.set(task.id, valid.length)
  })

  const queue = tasks.filter(task => indegree.get(task.id) === 0).map(task => task.id)
  const depthByTask = new Map<string, number>()
  let head = 0
  while (head < queue.length) {
    const id = queue[head]
    head++
    if (!id) continue
    const task = byId.get(id)
    const parents = deps.get(id) ?? []
    const resolved = options.activeOnly && (task?.status === "completed" || task?.status === "cancelled")
    depthByTask.set(
      id,
      resolved
        ? 0
        : parents.length === 0
          ? 1
          : Math.max(...parents.map(parent => depthByTask.get(parent) ?? 1)) + 1,
    )
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 1) - 1
      indegree.set(child, next)
      if (next === 0) queue.push(child)
    }
  }

  const cyclic = tasks.filter(task => !depthByTask.has(task.id)).map(task => task.id)
  return { depthByTask, cyclic, missing: [...missing] }
}

/** Depth a new task would have if it depended on `dependencyIds`. */
export function depthForDependencies(dependencyIds: string[], graph: TaskGraphInfo): number {
  if (dependencyIds.length === 0) return 1
  return Math.max(...dependencyIds.map(id => graph.depthByTask.get(id) ?? 1)) + 1
}
