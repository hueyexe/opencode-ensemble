import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/** Tracks the last time team_status was called per team ID (epoch ms). */
export const lastCallTime = new Map<string, number>()

const RATE_LIMIT_MS = 30_000

/** Format a duration in ms to a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

/**
 * Execute the team_status tool. Shows team overview with member statuses and task summary.
 */
export async function executeTeamStatus(
  deps: ToolDeps,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const now = Date.now()
  const last = lastCallTime.get(teamInfo.teamId)
  if (last !== undefined && (now - last) < RATE_LIMIT_MS) {
    return "No changes since last check."
  }
  lastCallTime.set(teamInfo.teamId, now)

  const members = deps.db.query(
    "SELECT name, session_id, agent, status, execution_status, worktree_branch, worktree_dir, plan_approval, time_updated FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId) as Array<{
    name: string; session_id: string; agent: string; status: string; execution_status: string; worktree_branch: string | null; worktree_dir: string | null; plan_approval: string; time_updated: number
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
      const duration = formatDuration(now - m.time_updated)
      const branch = m.worktree_branch ? `  branch: ${m.worktree_branch}` : ""
      const plan = m.plan_approval !== "none" ? `, plan: ${m.plan_approval}` : ""

      // Last message time
      const lastMsg = deps.db.query("SELECT MAX(time_created) as last_msg FROM team_message WHERE team_id = ? AND from_name = ?")
        .get(teamInfo.teamId, m.name) as { last_msg: number | null } | null
      const msgInfo = lastMsg?.last_msg ? `last msg: ${formatDuration(now - lastMsg.last_msg)} ago` : "no messages yet"

      lines.push(`  ${m.name}  [${statusIcon} ${duration}, ${msgInfo}${plan}]  agent: ${m.agent}${branch}`)

      // Current task
      const task = deps.db.query("SELECT content FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' LIMIT 1")
        .get(teamInfo.teamId, m.name) as { content: string } | null
      if (task) {
        const truncated = task.content.length > 80 ? `${task.content.slice(0, 80)}...` : task.content
        lines.push(`    task: ${truncated}`)
      }
      if (m.worktree_dir) {
        lines.push(`    worktree: ${m.worktree_dir}`)
      }
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
