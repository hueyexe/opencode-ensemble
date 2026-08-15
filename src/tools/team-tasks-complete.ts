import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { log } from "../log"

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 *
 * Enforces task-board accuracy (issue #27):
 * - Rejects completing an already-completed or cancelled task.
 * - Rejects completing a blocked task (dependencies must resolve first).
 * - Only the assignee (or the lead) may complete a claimed task.
 * - Completing an unclaimed task attributes it to the caller atomically.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const caller = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const task = deps.db.query("SELECT id, content, status, assignee FROM team_task WHERE id = ? AND team_id = ?")
    .get(args.task_id, teamInfo.teamId) as { id: string; content: string; status: string; assignee: string | null } | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)
  if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`)
  if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`)
  if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)
  if (task.status === "in_progress" && task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
    throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`)
  }

  const now = Date.now()
  if (task.assignee) {
    deps.db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [now, args.task_id])
  } else {
    // Attribute an unclaimed task to the caller so the board reflects who did it.
    const result = deps.db.run(
      "UPDATE team_task SET status = 'completed', assignee = ?, time_updated = ? WHERE id = ? AND assignee IS NULL",
      [caller, now, args.task_id]
    )
    if (result.changes === 0) {
      throw new Error(`Task "${args.task_id}" was just completed by another teammate`)
    }
  }

  // Unblock dependent tasks
  const allTasks = deps.db.query("SELECT id, depends_on, status FROM team_task WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ id: string; depends_on: string | null; status: string }>

  let unblocked = 0
  for (const t of allTasks) {
    if (t.status !== "blocked" || !t.depends_on) continue
    const depIds: string[] = JSON.parse(t.depends_on)
    if (!depIds.includes(args.task_id)) continue

    const allResolved = depIds.every(depId => {
      if (depId === args.task_id) return true
      const dep = allTasks.find(d => d.id === depId)
      return dep && (dep.status === "completed" || dep.status === "cancelled")
    })

    if (allResolved) {
      deps.db.run("UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = ?", [now, t.id])
      unblocked++
    }
  }

  // Fire progress toast so the lead has visibility
  const counts = deps.db.query(
    "SELECT status, COUNT(*) as c FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamInfo.teamId) as Array<{ status: string; c: number }>
  const completed = counts.find(r => r.status === "completed")?.c ?? 0
  const total = counts.reduce((sum, r) => sum + r.c, 0)
  const who = teamInfo.memberName ?? "teammate"
  try {
    deps.client.tui.showToast({
      title: "Team",
      message: `${who}: ${completed}/${total} tasks complete`,
      variant: "info",
      duration: 3000,
    }).catch(() => { /* TUI may not be available */ })
  } catch { log(`tasks-complete:toast:failed`) }

  const unblockedMsg = unblocked > 0 ? ` Unblocked ${unblocked} dependent task${unblocked !== 1 ? "s" : ""}.` : ""
  return `Completed task: ${task.content}${unblockedMsg}`
}
