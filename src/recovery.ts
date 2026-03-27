import type { Database } from "bun:sqlite"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import { getUndeliveredMessages, markDelivered } from "./messaging"

/**
 * Scan for team members stuck in 'busy' status (stale from a crash)
 * and mark them as 'error' with execution_status 'idle'.
 * Also aborts their orphaned sessions (best effort).
 * Only processes members in active teams.
 * Returns the count of interrupted members.
 */
export async function recoverStaleMembers(db: Database, client?: PluginClient): Promise<{ interrupted: number }> {
  // Find stale members before updating so we can abort their sessions
  const stale = db.query(
    `SELECT tm.session_id FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE tm.status = 'busy' AND t.status = 'active'`
  ).all() as Array<{ session_id: string }>

  const result = db.run(
    `UPDATE team_member SET status = 'error', execution_status = 'idle', time_updated = ?
     WHERE status = 'busy'
       AND team_id IN (SELECT id FROM team WHERE status = 'active')`,
    [Date.now()]
  )

  // Abort orphaned sessions (best effort)
  if (client) {
    for (const member of stale) {
      try {
        await client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }
    }
  }

  return { interrupted: result.changes }
}

/**
 * Clean up orphaned worktrees from archived teams or members that no longer exist.
 * Compares worktrees on disk (via client.worktree.list) against active team members.
 */
export async function recoverOrphanedWorktrees(db: Database, client: PluginClient): Promise<{ removed: number }> {
  let removed = 0

  try {
    const worktrees = await client.worktree.list()
    if (!worktrees.data) return { removed: 0 }

    // Get all active worktree directories from the DB
    const activeWorktrees = new Set(
      (db.query(
        `SELECT tm.worktree_dir FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE tm.worktree_dir IS NOT NULL AND t.status = 'active'`
      ).all() as Array<{ worktree_dir: string }>).map(r => r.worktree_dir)
    )

    for (const wt of worktrees.data) {
      // Only clean up worktrees created by ensemble (name starts with "ensemble-")
      if (!wt.name.startsWith("ensemble-")) continue
      if (activeWorktrees.has(wt.directory)) continue

      try {
        await client.worktree.remove({ worktreeRemoveInput: { directory: wt.directory } })
        removed++
      } catch { /* best effort */ }
    }
  } catch {
    // worktree.list may not be available — silently ignore
  }

  return { removed }
}

/**
 * Redeliver undelivered messages (delivered=0) via promptAsync.
 * Resolves recipient session IDs from the member registry or team lead.
 * Continues on partial failure — logs but doesn't abort.
 */
export async function recoverUndeliveredMessages(
  db: Database,
  client: PluginClient,
  registry: MemberRegistry,
): Promise<{ redelivered: number }> {
  // Get all active teams
  const teams = db.query("SELECT id, lead_session_id FROM team WHERE status = 'active'")
    .all() as Array<{ id: string; lead_session_id: string }>

  let redelivered = 0

  for (const team of teams) {
    const messages = getUndeliveredMessages(db, team.id)

    for (const msg of messages) {
      // Resolve recipient session ID
      let recipientSessionId: string | undefined

      if (msg.to_name === "lead") {
        // Skip lead-bound messages — the system prompt transform delivers them
        continue
      } else if (msg.to_name) {
        const entry = registry.getByName(team.id, msg.to_name)
        recipientSessionId = entry?.sessionId
      } else {
        // Broadcast — skip for now, broadcasts are best-effort
        continue
      }

      if (!recipientSessionId) continue

      try {
        await client.session.promptAsync({
          sessionID: recipientSessionId,
          parts: [{ type: "text", text: `[Recovered team message from ${msg.from_name}]: ${msg.content}` }],
        })
        markDelivered(db, msg.id)
        redelivered++
      } catch {
        // Continue on failure — message stays undelivered for next recovery
      }
    }
  }

  return { redelivered }
}
