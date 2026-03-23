import type { ToolDeps } from "../types"
import { findTeamBySession, getLeadAgent } from "../types"
import { broadcastMessage, markDelivered } from "../messaging"

/**
 * Execute the team_broadcast tool. Sends a message to all team members + lead (excluding sender).
 */
export async function executeTeamBroadcast(
  deps: ToolDeps,
  args: { text: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.")

  const senderName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

  const msgId = broadcastMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: senderName,
    content: args.text,
  })

  // Collect all recipient session IDs (excluding sender)
  const recipients: Array<{ name: string; sessionId: string }> = []

  // Add lead if sender is not lead
  if (teamInfo.role !== "lead") {
    const leadSession = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?")
      .get(teamInfo.teamId) as { lead_session_id: string } | null
    if (leadSession) recipients.push({ name: "lead", sessionId: leadSession.lead_session_id })
  }

  // Add all members except sender
  const members = deps.registry.listByTeam(teamInfo.teamId)
  for (const member of members) {
    if (member.sessionId !== sessionId) {
      recipients.push({ name: member.memberName, sessionId: member.sessionId })
    }
  }

  // Look up lead's agent mode for preserving it on delivery
  const leadAgent = getLeadAgent(deps.db, teamInfo.teamId)

  // Deliver to all recipients — partial failures logged but don't fail the broadcast
  let delivered = 0
  for (const recipient of recipients) {
    try {
      const isLead = recipient.name === "lead"
      await deps.client.session.promptAsync({
        sessionID: recipient.sessionId,
        parts: [{ type: "text", text: `[Team broadcast from ${senderName}]: ${args.text}` }],
        ...(isLead && leadAgent ? { agent: leadAgent } : {}),
      })
      delivered++
    } catch {
      // Log but don't fail
    }
  }

  // Only mark delivered if at least one recipient received it
  if (delivered > 0) {
    markDelivered(deps.db, msgId)
  }

  return `Broadcast sent to ${delivered} recipient${delivered !== 1 ? "s" : ""}.`
}
