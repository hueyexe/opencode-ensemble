import type { Database } from "./db"
import type { PluginClient } from "./types"
import { getSessionSelection } from "./member-model"
import { log } from "./log"

/** Options for a lead wake. */
export interface WakeLeadOptions {
  /** Send even when the lead session is busy (system/error notifications). */
  force?: boolean
}

/** Per-database coalescing state, so separate plugin instances/DBs don't share it. */
interface WakeState {
  /** Last successful wake time per team, used to coalesce bursts. */
  lastWakeAt: Map<string, number>
  /** Teams with a wake currently being resolved/sent. */
  inFlight: Set<string>
}

const states = new WeakMap<Database, WakeState>()
const WAKE_COOLDOWN_MS = 5000

function stateFor(db: Database): WakeState {
  let state = states.get(db)
  if (!state) {
    state = { lastWakeAt: new Map(), inFlight: new Set() }
    states.set(db, state)
  }
  return state
}

interface PendingLeadWake {
  leadSessionID: string
  count: number
  senders: string[]
}

/**
 * Resolve whether a team still has messages the lead has neither seen in the
 * system prompt (delivered) nor read via team_results (read). Resolving from
 * the DB at fire time is what prevents wakes from landing in an archived or
 * purged team (#48) or after the inbox was drained (#57).
 */
function pendingLeadWake(db: Database, teamId: string): PendingLeadWake | undefined {
  const team = db.query("SELECT lead_session_id FROM team WHERE id = ? AND status = 'active'")
    .get(teamId) as { lead_session_id: string } | null
  if (!team?.lead_session_id) return undefined

  const row = db.query(
    `SELECT COUNT(*) as c, GROUP_CONCAT(DISTINCT from_name) as senders
     FROM team_message
     WHERE team_id = ? AND to_name = 'lead' AND read = 0 AND delivered = 0`,
  ).get(teamId) as { c: number; senders: string | null }
  if (row.c === 0) return undefined

  return {
    leadSessionID: team.lead_session_id,
    count: row.c,
    senders: row.senders ? row.senders.split(",").filter(Boolean) : [],
  }
}

/** Best-effort busy check. Unknown status is treated as idle so wakes are not lost. */
async function isSessionBusy(client: PluginClient, sessionID: string): Promise<boolean> {
  try {
    const status = await client.session.status()
    const entry = status.data?.[sessionID]
    return entry?.type === "busy" || entry?.type === "retry"
  } catch {
    return false
  }
}

/**
 * Wake a team's lead only when the team is still active and has genuinely
 * unseen messages. The team and pending count are resolved at fire time, so a
 * wake scheduled before team_cleanup cannot wake the lead into a dead team.
 *
 * Coalesces bursts: concurrent calls for the same team collapse into one, and
 * a successful wake suppresses further wakes for {@link WAKE_COOLDOWN_MS}.
 * A busy lead is left alone (the idle backstop will wake it) unless
 * `force` is set for system/error notifications.
 *
 * Fire-and-forget by design: callers should not await this in delivery paths.
 * Returns true when a wake was actually sent.
 */
export async function wakeLeadIfPending(
  client: PluginClient,
  db: Database,
  teamId: string,
  options: WakeLeadOptions = {},
): Promise<boolean> {
  const state = stateFor(db)
  if (state.inFlight.has(teamId)) return false

  const before = pendingLeadWake(db, teamId)
  if (!before) {
    log(`wake:skip team=${teamId} reason=no-unseen`)
    return false
  }

  const now = Date.now()
  if (now - (state.lastWakeAt.get(teamId) ?? 0) < WAKE_COOLDOWN_MS) {
    log(`wake:skip team=${teamId} reason=cooldown`)
    return false
  }

  state.inFlight.add(teamId)
  try {
    if (!options.force && await isSessionBusy(client, before.leadSessionID)) {
      log(`wake:skip team=${teamId} reason=lead-busy`)
      return false
    }

    // On V1 a wake is a normal user turn, so pass the lead's current agent and
    // model explicitly to stop OpenCode falling back to Build/default (#37).
    // V2 wakes are synthetic and ignore both, so skip the lookup there.
    const selection = client.agent
      ? {}
      : await getSessionSelection(client, before.leadSessionID).catch(() => ({}))

    // Re-check after the async lookups: the team may have been archived or
    // purged, or the lead may have drained the inbox in the meantime.
    const after = pendingLeadWake(db, teamId)
    if (!after) {
      log(`wake:skip team=${teamId} reason=drained`)
      return false
    }

    state.lastWakeAt.set(teamId, Date.now())
    const senderText = after.senders.length > 0 ? ` from ${after.senders.join(", ")}` : ""
    client.session.promptAsync({
      sessionID: after.leadSessionID,
      parts: [{ type: "text", text: `[System: ${after.count} new team message(s)${senderText}] — use team_results to read them` }],
      synthetic: true,
      ...(selection.agent ? { agent: selection.agent } : {}),
      ...(selection.model ? { model: selection.model } : {}),
    }).catch((err) => {
      log(`wake:send:failed team=${teamId} err=${err instanceof Error ? err.message : String(err)}`)
    })
    log(`wake:sent team=${teamId} count=${after.count}`)
    return true
  } finally {
    state.inFlight.delete(teamId)
  }
}

/** Clear in-memory wake coalescing state for a database (tests). */
export function resetWakeState(db: Database): void {
  states.delete(db)
}
