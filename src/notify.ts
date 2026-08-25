import type { Database } from "./db"
import type { PluginClient } from "./types"
import { sendMessage } from "./messaging"
import { log } from "./log"

type TeamEventType = "spawn" | "message" | "completed" | "error" | "shutdown"

const TOAST_CONFIG: Record<TeamEventType, { variant: "info" | "success" | "warning" | "error"; duration: number }> = {
  spawn: { variant: "success", duration: 3000 },
  message: { variant: "info", duration: 3000 },
  completed: { variant: "info", duration: 4000 },
  error: { variant: "error", duration: 5000 },
  shutdown: { variant: "info", duration: 3000 },
}

function formatMessage(type: TeamEventType, data: Record<string, string>): string {
  switch (type) {
    case "spawn": return `Teammate ${data.memberName} spawned (${data.agent})`
    case "message": return `Message from ${data.from}`
    case "completed": return `${data.memberName} finished work`
    case "error": return `${data.memberName} encountered an error`
    case "shutdown": return `${data.memberName} shut down`
  }
}

/**
 * Fire a toast notification for a team event.
 * Silently swallows errors — TUI may not be available.
 */
export async function notifyTeamEvent(
  client: PluginClient,
  type: TeamEventType,
  data: Record<string, string>,
): Promise<void> {
  const config = TOAST_CONFIG[type]
  try {
    await client.tui.showToast({
      title: "Team",
      message: formatMessage(type, data),
      variant: config.variant,
      duration: config.duration,
    })
  } catch {
    // TUI may not be available — silently ignore
  }
}

/**
 * Fire a toast showing which teammates are still working.
 * Called on every session.status transition so the user sees live progress.
 * Does nothing if the team has no members.
 */
export async function notifyWorkingProgress(
  client: PluginClient,
  db: Database,
  teamId: string,
): Promise<void> {
  const members = db.query(
    "SELECT name, status FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamId) as Array<{ name: string; status: string }>

  if (members.length === 0) return

  const busy = members.filter(m => m.status === "busy")

  try {
    if (busy.length === 0) {
      await client.tui.showToast({
        title: "Team",
        message: "All teammates finished",
        variant: "success",
        duration: 4000,
      })
    } else {
      const names = busy.map(m => m.name).join(", ")
      await client.tui.showToast({
        title: "Team",
        message: `Working: ${names} (${busy.length}/${members.length})`,
        variant: "info",
        duration: 5000,
      })
    }
  } catch {
    // TUI may not be available — silently ignore
  }
}

/**
 * Persist a system-generated message to the lead AND actively wake the lead
 * so the message is delivered on the lead's next turn.
 *
 * This is the delivery path for system events (teammate errors, timeouts,
 * stalls, spawn failures). Unlike the passive wake-lead path in the event
 * hook, this ALWAYS fires a promptAsync regardless of whether teammates are
 * still busy — an errored/aborted teammate is precisely the case where the
 * "all teammates done" gate would otherwise suppress the wake and strand the
 * message in the DB with delivered=0.
 *
 * The message is persisted first; the promptAsync wake is fire-and-forget
 * (never awaited, per the plugin's promptAsync invariant). If the wake fails,
 * the message is still in the DB and the passive backstop / recovery paths
 * remain available.
 *
 * Returns the persisted message id.
 */
export function notifyLead(
  client: PluginClient,
  db: Database,
  teamId: string,
  content: string,
): string {
  const id = sendMessage(db, { teamId, from: "system", to: "lead", content })

  const team = db.query("SELECT lead_session_id FROM team WHERE id = ?")
    .get(teamId) as { lead_session_id: string } | null
  if (!team?.lead_session_id) return id

  // Fire-and-forget wake — the system prompt transform delivers the actual
  // content on the lead's next turn.
  client.session.promptAsync({
    sessionID: team.lead_session_id,
    parts: [{ type: "text", text: "[System: New team message from system]" }],
  }).catch((err) => {
    log(`notifyLead:wake:failed team=${teamId} err=${err instanceof Error ? err.message : String(err)}`)
  })

  return id
}
