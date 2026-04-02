import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/**
 * Execute the team_tasks_list tool. Shows all tasks on the shared board.
 */
export async function executeTeamTasksList(
  deps: ToolDeps,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const tasks = deps.db.query(
    "SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId) as Array<Record<string, unknown>>

  if (tasks.length === 0) return "No tasks on the board."

  return tasks.map(t =>
    `[${t.status}] ${t.content} (${t.id})${t.assignee ? ` → ${t.assignee}` : ""}${t.priority !== "medium" ? ` [${t.priority}]` : ""}`
  ).join("\n")
}
