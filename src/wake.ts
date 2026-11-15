import type { Database } from "./db"
import type { PluginClient } from "./types"
import { getSessionSelection } from "./member-model"
import { log } from "./log"

/** Options for a lead wake. */
export interface WakeLeadOptions {
  /** Send even when the lead session is busy, and skip the cooldown (system/error notifications). */
  force?: boolean
  /** Coalescing window override (tests); defaults to {@link WAKE_COOLDOWN_MS}. */
  cooldownMs?: number
}

/** Per-database coalescing state, so separate plugin instances/DBs don't share it. */
interface WakeState {
  /** Teams with a wake currently being resolved/sent. */
  inFlight: Set<string>
  /** Trailing retries scheduled after a cooldown skip. */
  timers: Map<string, ReturnType<typeof setTimeout>>
}

const states = new WeakMap<Database, WakeState>()
const WAKE_COOLDOWN_MS = 5000

function stateFor(db: Database): WakeState {
  let state = states.get(db)
  if (!state) {
    state = { inFlight: new Set(), timers: new Map() }
    states.set(db, state)
  }
  return state
}

interface PendingLeadWake {
  leadSessionID: string
  count: number
  senders: string[]
  lastWakeAt: number
  leadStatus: string
}

/**
 * Resolve whether a team still has messages the lead has neither seen in the
 * system prompt (delivered) nor read via team_results (read). Resolving from
 * the DB at fire time is what prevents wakes from landing in an archived or
 * purged team (#48) or after the inbox was drained (#57).
 */
function pendingLeadWake(db: Database, teamId: string): PendingLeadWake | undefined {
  const team = db.query("SELECT lead_session_id, last_wake_at, lead_status FROM team WHERE id = ? AND status = 'active'")
    .get(teamId) as { lead_session_id: string; last_wake_at: number; lead_status: string } | null
  if (!team?.lead_session_id) return undefined

  const row = db.query(
    `SELECT COUNT(*) as c, GROUP_CONCAT(DISTINCT from_name) as senders
     FROM team_message
     WHERE team_id = ? AND to_name = 'lead' AND read = 0 AND delivered = 0
       AND wake_suppressed = 0`,
  ).get(teamId) as { c: number; senders: string | null }
  if (row.c === 0) return undefined

  return {
    leadSessionID: team.lead_session_id,
    count: row.c,
    senders: row.senders ? row.senders.split(",").filter(Boolean) : [],
    lastWakeAt: team.last_wake_at,
    leadStatus: team.lead_status,
  }
}

/** A lead is busy while its session is actively running or retrying. */
function leadIsBusy(status: string): boolean {
  return status === "busy" || status === "retry"
}

/** Schedule one trailing re-check after a cooldown skip. */
function scheduleCooldownRetry(
  client: PluginClient,
  db: Database,
  teamId: string,
  options: WakeLeadOptions,
  delayMs: number,
): void {
  const state = stateFor(db)
  if (state.timers.has(teamId)) return
  const timer = setTimeout(() => {
    state.timers.delete(teamId)
    wakeLeadIfPending(client, db, teamId, options).catch((err) => {
      log(`wake:retry:failed team=${teamId} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }, Math.max(0, delayMs))
  ;(timer as { unref?: () => void }).unref?.()
  state.timers.set(teamId, timer)
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

  const cooldownMs = options.cooldownMs ?? WAKE_COOLDOWN_MS
  const now = Date.now()
  if (!options.force && now - before.lastWakeAt < cooldownMs) {
    const remaining = cooldownMs - (now - before.lastWakeAt)
    scheduleCooldownRetry(client, db, teamId, options, remaining)
    log(`wake:skip team=${teamId} reason=cooldown retryIn=${remaining}ms`)
    return false
  }

  state.inFlight.add(teamId)
  try {
    // A busy lead is left alone: queueing a wake behind its current turn can
    // produce an empty wake if the lead drains the inbox before the queued
    // message is processed (#57). Both hosts retry on the lead's next idle
    // event (V1 in index.ts, V2 in v2-setup.ts), which re-checks unseen
    // messages first. lead_status is persisted so this decision is reliable
    // from teammate instances and between LLM steps. System/error
    // notifications can force the wake.
    if (!options.force && leadIsBusy(before.leadStatus)) {
      log(`wake:skip team=${teamId} reason=lead-busy status=${before.leadStatus}`)
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
    if (!options.force && leadIsBusy(after.leadStatus)) {
      log(`wake:skip team=${teamId} reason=lead-busy status=${after.leadStatus}`)
      return false
    }

    const pendingTimer = state.timers.get(teamId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      state.timers.delete(teamId)
    }
    // Persisted, not in-memory: worktree teammate instances share this DB.
    db.run("UPDATE team SET last_wake_at = ? WHERE id = ? AND status = 'active'", [Date.now(), teamId])
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

/** Clear wake coalescing state for a database (tests). */
export function resetWakeState(db: Database): void {
  const state = states.get(db)
  if (state) {
    for (const timer of state.timers.values()) clearTimeout(timer)
    states.delete(db)
  }
  try {
    db.run("UPDATE team SET last_wake_at = 0")
  } catch {
    // The table may not exist yet in a partially initialized test DB.
  }
}
