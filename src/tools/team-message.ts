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

  // Deliver via promptAsync
  await deps.client.session.promptAsync({
    path: { id: recipientSessionId },
    body: { parts: [{ type: "text", text: `[Team message from ${senderName}]: ${args.text}` }] },
  })

  markDelivered(deps.db, msgId)

  return `Message sent to ${args.to}.`
}
