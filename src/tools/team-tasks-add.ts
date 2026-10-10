import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"

interface TaskInput {
  content: string
  priority: string
  depends_on?: string[]
}

/**
 * Execute the team_tasks_add tool. Adds tasks to the shared board.
 * Tasks with unresolved dependencies are marked as 'blocked'.
 */
export async function executeTeamTasksAdd(
  deps: ToolDeps,
  args: { tasks: TaskInput[] },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  // Validate every dependency before inserting anything. A typo'd id used to
  // create a task that was blocked, unclaimable, and uncompletable — dead
  // until the team was purged, because no tool edits depends_on (issue #40).
  const unknown: string[] = []
  for (const task of args.tasks) {
    for (const depId of task.depends_on ?? []) {
      const dep = deps.db.query("SELECT id FROM team_task WHERE id = ? AND team_id = ?")
        .get(depId, teamInfo.teamId)
      if (!dep) unknown.push(depId)
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown depends_on id${unknown.length !== 1 ? "s" : ""}: ${[...new Set(unknown)].join(", ")}. ` +
      `Use team_tasks_list to get real task ids (they look like task_xxx). Nothing was added.`
    )
  }

  const ids: string[] = []
  const now = Date.now()

  for (const task of args.tasks) {
    const id = generateId("task")
    const depsJson = task.depends_on?.length ? JSON.stringify(task.depends_on) : null

    // Determine initial status — blocked if has unresolved dependencies
    let status = "pending"
    if (task.depends_on?.length) {
      const resolved = task.depends_on.every(depId => {
        const dep = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
          .get(depId, teamInfo.teamId) as { status: string } | null
        return dep && (dep.status === "completed" || dep.status === "cancelled")
      })
      if (!resolved) status = "blocked"
    }

    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, depends_on, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, teamInfo.teamId, task.content, status, task.priority, depsJson, now, now]
    )
    ids.push(id)
  }

  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${ids.join(", ")}`
}
