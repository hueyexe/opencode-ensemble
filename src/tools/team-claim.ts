import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/**
 * Execute the team_claim tool. Atomically claims a pending task.
 * Rejects if the task is already claimed, blocked, or not pending.
 */
export async function executeTeamClaim(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")

  const claimerName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

  const task = deps.db.query("SELECT * FROM team_task WHERE id = ? AND team_id = ?")
    .get(args.task_id, teamInfo.teamId) as Record<string, unknown> | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)
  if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)
  if (task.status !== "pending") throw new Error(`Task "${args.task_id}" is not pending (status: ${task.status})`)
  if (task.assignee) throw new Error(`Task "${args.task_id}" is already claimed by ${task.assignee}`)

  // Atomic claim: UPDATE only if still pending and unassigned
  const result = deps.db.run(
    "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND status = 'pending' AND assignee IS NULL",
    [claimerName, Date.now(), args.task_id]
  )

  if (result.changes === 0) {
    throw new Error(`Task "${args.task_id}" is already claimed (race condition)`)
  }

  return `Claimed task: ${task.content}`
}
