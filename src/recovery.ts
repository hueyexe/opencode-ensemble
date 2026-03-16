import type { Database } from "bun:sqlite"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import { getUndeliveredMessages, markDelivered } from "./messaging"

/**
 * Scan for team members stuck in 'busy' status (stale from a crash)
 * and mark them as 'error' with execution_status 'idle'.
 * Only processes members in active teams.
 * Returns the count of interrupted members.
 */
export function recoverStaleMembers(db: Database): { interrupted: number } {
  const result = db.run(
    `UPDATE team_member SET status = 'error', execution_status = 'idle', time_updated = ?
     WHERE status = 'busy'
       AND team_id IN (SELECT id FROM team WHERE status = 'active')`,
    [Date.now()]
  )
  return { interrupted: result.changes }
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
        recipientSessionId = team.lead_session_id
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
          path: { id: recipientSessionId },
          body: { parts: [{ type: "text", text: `[Recovered team message from ${msg.from_name}]: ${msg.content}` }] },
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
