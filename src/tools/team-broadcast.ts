import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { broadcastMessage, markDelivered, hasReportedCompletion } from "../messaging"
import { log } from "../log"

/**
 * Execute the team_broadcast tool. Sends a message to all team members + lead (excluding sender).
 */
export async function executeTeamBroadcast(
  deps: ToolDeps,
  args: { text: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const senderName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

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

  // Fire-and-forget: deliver to all recipients. Message is already persisted in DB.
  // Skip completed teammates to prevent re-waking them (issue #3).
  let delivered = 0
  let skipped = 0
  for (const recipient of recipients) {
    if (recipient.name !== "lead" && hasReportedCompletion(deps.db, teamInfo.teamId, recipient.name)) {
      skipped++
      continue
    }
    deps.client.session.promptAsync({
      sessionID: recipient.sessionId,
      parts: [{ type: "text", text: `[Team broadcast from ${senderName}]: ${args.text}` }],
    }).then(() => {
      delivered++
      if (delivered === 1) markDelivered(deps.db, msgId)
    }).catch((err) => {
      log(`team_broadcast:deliver:failed to=${recipient.name} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const sent = recipients.length - skipped
  return `Broadcast sent to ${sent} recipient${sent !== 1 ? "s" : ""}.`
}
