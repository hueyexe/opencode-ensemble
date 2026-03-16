import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"
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
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")

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
