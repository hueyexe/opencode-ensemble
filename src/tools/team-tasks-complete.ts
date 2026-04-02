import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const task = deps.db.query("SELECT * FROM team_task WHERE id = ? AND team_id = ?")
    .get(args.task_id, teamInfo.teamId) as Record<string, unknown> | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)

  const now = Date.now()
  deps.db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [now, args.task_id])

  // Unblock dependent tasks
  const allTasks = deps.db.query("SELECT id, depends_on, status FROM team_task WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ id: string; depends_on: string | null; status: string }>

  let unblocked = 0
  for (const t of allTasks) {
    if (t.status !== "blocked" || !t.depends_on) continue
    const depIds: string[] = JSON.parse(t.depends_on)
    if (!depIds.includes(args.task_id)) continue

    // Check if all dependencies are now resolved
    const allResolved = depIds.every(depId => {
      if (depId === args.task_id) return true // just completed
      const dep = allTasks.find(d => d.id === depId)
      return dep && (dep.status === "completed" || dep.status === "cancelled")
    })

    if (allResolved) {
      deps.db.run("UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = ?", [now, t.id])
      unblocked++
    }
  }

  const unblockedMsg = unblocked > 0 ? ` Unblocked ${unblocked} dependent task${unblocked !== 1 ? "s" : ""}.` : ""
  return `Completed task: ${task.content}${unblockedMsg}`
}
