import type { ToolDeps } from "../types"
import { findTeamBySession, resolveRecipientSession } from "../types"
import { sendMessage, markDelivered } from "../messaging"

/**
 * Execute the team_message tool. Sends a direct message to a teammate or lead.
 * Optionally approves or rejects a teammate's plan (lead only).
 */
export async function executeTeamMessage(
  deps: ToolDeps,
  args: { to: string; text: string; approve?: boolean; reject?: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.")

  const senderName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const recipientSessionId = resolveRecipientSession(deps.db, deps.registry, teamInfo.teamId, args.to)
  if (!recipientSessionId) throw new Error(`Recipient "${args.to}" not found in team "${teamInfo.teamName}"`)

  // Handle plan approval/rejection
  let messageText = args.text
  if (args.approve || args.reject) {
    if (args.approve && args.reject) {
      throw new Error("Cannot both approve and reject a plan.")
    }
    if (teamInfo.role !== "lead") {
      throw new Error("Only the lead can approve or reject plans.")
    }
    const recipient = deps.db.query(
      "SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?"
    ).get(teamInfo.teamId, args.to) as { plan_approval: string } | null
    if (!recipient || recipient.plan_approval !== "pending") {
      throw new Error(`Recipient "${args.to}" is not in plan approval mode (plan_approval is not pending).`)
    }
    if (args.approve) {
      deps.db.run(
        "UPDATE team_member SET plan_approval = 'approved', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), teamInfo.teamId, args.to]
      )
      messageText = `[Plan Approved] ${args.text}`
    } else {
      deps.db.run(
        "UPDATE team_member SET plan_approval = 'rejected', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), teamInfo.teamId, args.to]
      )
      messageText = `[Plan Rejected: ${args.reject}] ${args.text}`
    }
  }

  const msgId = sendMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: senderName,
    to: args.to,
    content: messageText,
  })

  // Deliver via promptAsync — truncate lead-bound messages over 500 chars
  const isToLead = args.to === "lead"
  const MAX_LEAD_MSG = 500
  let deliveryText: string
  if (isToLead && messageText.length > MAX_LEAD_MSG) {
    const truncated = messageText.slice(0, MAX_LEAD_MSG)
    deliveryText = `[Team message from ${senderName}]: ${truncated}... (use team_results to read full message)`
  } else {
    deliveryText = `[Team message from ${senderName}]: ${messageText}`
  }

  // Check if recipient is busy — if so, queue the message for later delivery.
  // TOCTOU: status check and promptAsync are not atomic. A recipient can transition
  // idle→busy between the check and delivery. This is accepted as benign — the idle-flush
  // backstop catches anything that slips through, so no messages are lost.
  let recipientBusy = false
  try {
    const statusResult = await deps.client.session.status()
    const sessionStatus = statusResult.data?.[recipientSessionId]
    if (sessionStatus?.type === "busy") {
      recipientBusy = true
    }
  } catch { /* status check failed — deliver anyway as best effort */ }

  if (recipientBusy) {
    // Message is stored in DB with delivered=0, will be flushed when recipient goes idle
    return `Message sent to ${args.to}. (queued — recipient is busy)`
  }

  // Fire-and-forget: message is already persisted in DB. If delivery fails,
  // the idle-flush backstop will redeliver it.
  deps.client.session.promptAsync({
    sessionID: recipientSessionId,
    parts: [{ type: "text", text: deliveryText }],
  }).then(() => {
    markDelivered(deps.db, msgId)
  }).catch(() => { /* message stays delivered=0, idle-flush will retry */ })

  return `Message sent to ${args.to}.`
}
