import type { ToolDeps } from "../types"
import { findTeamBySession, resolveRecipientSession } from "../types"
import { sendMessage, markDelivered } from "../messaging"
import { log } from "../log"

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

  const isToLead = args.to === "lead"

  // Lead-bound messages: store in DB, then wake the lead with a minimal promptAsync.
  // The system prompt transform delivers the actual message content on the lead's next turn.
  // This runs in the teammate's worktree instance — the event hook can't wake the lead
  // because session.idle events are scoped per-instance.
  if (isToLead) {
    log(`team_message:wake-lead from=${senderName} recipientSession=${recipientSessionId}`)
    deps.client.session.promptAsync({
      sessionID: recipientSessionId,
      parts: [{ type: "text", text: `[System: New team message from ${senderName}]` }],
    }).catch((err) => {
      log(`team_message:wake-lead:failed from=${senderName} err=${err instanceof Error ? err.message : String(err)}`)
    })
    return `Message sent to ${args.to}.`
  }

  // For member-to-member messages, fire-and-forget delivery is safe.
  const deliveryText = `[Team message from ${senderName}]: ${messageText}`
  deps.client.session.promptAsync({
    sessionID: recipientSessionId,
    parts: [{ type: "text", text: deliveryText }],
  }).then(() => {
    markDelivered(deps.db, msgId)
  }).catch((err) => {
    log(`team_message:deliver:failed to=${args.to} err=${err instanceof Error ? err.message : String(err)}`)
  })

  return `Message sent to ${args.to}.`
}
