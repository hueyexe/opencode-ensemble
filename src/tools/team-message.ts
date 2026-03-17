import type { ToolDeps } from "../types"
import { findTeamBySession, resolveRecipientSession } from "../types"
import { sendMessage, markDelivered } from "../messaging"

/**
 * Execute the team_message tool. Sends a direct message to a teammate or lead.
 */
export async function executeTeamMessage(
  deps: ToolDeps,
  args: { to: string; text: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.")

  const senderName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

  const recipientSessionId = resolveRecipientSession(deps.db, deps.registry, teamInfo.teamId, args.to)
  if (!recipientSessionId) throw new Error(`Recipient "${args.to}" not found in team "${teamInfo.teamName}"`)

  const msgId = sendMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: senderName,
    to: args.to,
    content: args.text,
  })

  // Deliver via promptAsync — truncate lead-bound messages over 500 chars
  const isToLead = args.to === "lead"
  const MAX_LEAD_MSG = 500
  let deliveryText: string
  if (isToLead && args.text.length > MAX_LEAD_MSG) {
    const truncated = args.text.slice(0, MAX_LEAD_MSG)
    deliveryText = `[Team message from ${senderName}]: ${truncated}... (use team_results to read full message)`
  } else {
    deliveryText = `[Team message from ${senderName}]: ${args.text}`
  }

  await deps.client.session.promptAsync({
    path: { id: recipientSessionId },
    body: { parts: [{ type: "text", text: deliveryText }] },
  })

  markDelivered(deps.db, msgId)

  return `Message sent to ${args.to}.`
}
