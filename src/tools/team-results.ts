import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/** Row shape for unread messages query. */
interface UnreadMessageRow {
  id: string
  from_name: string
  content: string
  time_created: number
}

/**
 * Retrieve unread messages from the team message store.
 * Optionally filter by sender name. Marks returned messages as read.
 */
export async function executeTeamResults(
  deps: ToolDeps,
  args: { from?: string },
  sessionId: string,
): Promise<string> {
  const team = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!team) throw new Error("not in a team")

  const rows = args.from
    ? (deps.db
        .query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND from_name = ? ORDER BY time_created ASC",
        )
        .all(team.teamId, args.from) as UnreadMessageRow[])
    : (deps.db
        .query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 ORDER BY time_created ASC",
        )
        .all(team.teamId) as UnreadMessageRow[])

  if (rows.length === 0) return "No unread messages."

  // Mark all returned messages as read
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(", ")
  deps.db.run(`UPDATE team_message SET read = 1 WHERE id IN (${placeholders})`, ids)

  // Format output
  return rows.map((r) => `[Message from ${r.from_name}]:\n${r.content}\n`).join("\n")
}
