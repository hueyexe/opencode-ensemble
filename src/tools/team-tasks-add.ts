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

  // Reject unknown dependency IDs before inserting anything: a task blocked on
  // an ID that never existed can never unblock (issue #40). IDs are generated
  // here, so new tasks can only depend on existing ones and no cycle can form.
  const unknown = new Set<string>()
  for (const task of args.tasks) {
    for (const depId of task.depends_on ?? []) {
      const exists = deps.db.query("SELECT 1 FROM team_task WHERE id = ? AND team_id = ?").get(depId, teamInfo.teamId)
      if (!exists) unknown.add(depId)
    }
  }
  if (unknown.size > 0) {
    throw new Error(
      `Unknown task ID${unknown.size > 1 ? "s" : ""} in depends_on: ${[...unknown].join(", ")}. ` +
        "Use IDs from team_tasks_list, or add the prerequisite tasks first and reference the IDs they return.",
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
