import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/** Tracks the last time team_status was called per team ID (epoch ms). */
export const lastCallTime = new Map<string, number>()

const RATE_LIMIT_MS = 30_000

/**
 * Execute the team_status tool. Shows team overview with member statuses and task summary.
 */
export async function executeTeamStatus(
  deps: ToolDeps,
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")

  const now = Date.now()
  const last = lastCallTime.get(teamInfo.teamId)
  if (last !== undefined && (now - last) < RATE_LIMIT_MS) {
    return "No changes since last check."
  }
  lastCallTime.set(teamInfo.teamId, now)

  const members = deps.db.query(
    "SELECT name, session_id, agent, status, execution_status FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId) as Array<{
    name: string; session_id: string; agent: string; status: string; execution_status: string
  }>

  const tasks = deps.db.query(
    "SELECT status FROM team_task WHERE team_id = ?"
  ).all(teamInfo.teamId) as Array<{ status: string }>

  const lines: string[] = []
  lines.push(`Team: ${teamInfo.teamName} (you are the ${teamInfo.role})`)
  lines.push("")

  if (members.length === 0) {
    lines.push("No teammates spawned yet.")
  } else {
    lines.push("Members:")
    for (const m of members) {
      const statusIcon = m.status === "busy" ? "working" : m.status === "ready" ? "idle" : m.status
      lines.push(`  ${m.name}  [${statusIcon}]  agent: ${m.agent}  session: ${m.session_id}`)
    }
  }

  if (tasks.length > 0) {
    const byStatus = new Map<string, number>()
    for (const t of tasks) {
      byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1)
    }
    const parts = Array.from(byStatus.entries()).map(([s, n]) => `${n} ${s}`)
    lines.push("")
    lines.push(`Tasks: ${tasks.length} total (${parts.join(", ")})`)
  }

  // Fire a toast so the user (not just the model) sees the status summary
  if (members.length > 0) {
    const memberParts = members.map(m => {
      const label = m.status === "busy" ? "working" : m.status === "ready" ? "idle" : m.status
      return `${m.name} [${label}]`
    })
    let toastMsg = memberParts.join(", ")
    if (tasks.length > 0) {
      const completed = tasks.filter(t => t.status === "completed").length
      toastMsg += ` | Tasks: ${completed}/${tasks.length} done`
    }
    try {
      await deps.client.tui.showToast({
        title: "Team",
        message: toastMsg,
        variant: "info",
        duration: 4000,
      })
    } catch {
      // TUI may not be available — silently ignore
    }
  }

  return lines.join("\n")
}
