import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { parseTaskResult, formatTaskResult } from "../result-parser"

/** Row shape for unread messages query. */
interface UnreadMessageRow {
  id: string
  from_name: string
  content: string
  time_created: number
}

/**
 * Retrieve unread messages from the caller's inbox.
 * Optionally filter by sender name. Marks returned messages as read.
 *
 * The query is recipient-scoped: a teammate calling team_results must not
 * drain messages addressed to the lead (or to another teammate), or those
 * messages would disappear from the recipient's system prompt and wake path.
 * Broadcast rows (to_name IS NULL) are visible to every team member.
 */
export async function executeTeamResults(
  deps: ToolDeps,
  args: { from?: string },
  sessionId: string,
): Promise<string> {
  const team = requireTeamMember(deps, sessionId)
  const inbox = team.role === "lead" ? "lead" : (team.memberName ?? "")

  const rows = args.from
    ? (deps.db
        .query(
          `SELECT id, from_name, content, time_created FROM team_message
           WHERE team_id = ? AND read = 0 AND (to_name = ? OR to_name IS NULL) AND from_name = ?
           ORDER BY time_created ASC`,
        )
        .all(team.teamId, inbox, args.from) as UnreadMessageRow[])
    : (deps.db
        .query(
          `SELECT id, from_name, content, time_created FROM team_message
           WHERE team_id = ? AND read = 0 AND (to_name = ? OR to_name IS NULL)
           ORDER BY time_created ASC`,
        )
        .all(team.teamId, inbox) as UnreadMessageRow[])

  if (rows.length === 0) return "No unread messages."

  // Mark all returned messages as read
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(", ")
  deps.db.run(`UPDATE team_message SET read = 1 WHERE id IN (${placeholders})`, ids)

  // Format output — parse structured task results when present
  return rows.map((r) => {
    const parsed = parseTaskResult(r.content)
    if (parsed) return formatTaskResult(r.from_name, parsed)
    return `[Message from ${r.from_name}]:\n${r.content}`
  }).join("\n\n")
}
