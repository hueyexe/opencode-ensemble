import type { ToolDeps } from "../types"
import { findTeamBySession, resolveRecipientSession } from "../types"
import { sendMessage, markDelivered } from "../messaging"

/**
 * Execute the team_approve_plan tool. Approves or rejects a teammate's plan
 * and notifies them via message.
 */
export async function executeTeamApprovePlan(
  deps: ToolDeps,
  args: { member: string; approved: boolean; feedback?: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can approve plans.")

  const member = deps.db.query("SELECT session_id, status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  const text = args.approved
    ? `Your plan has been APPROVED.${args.feedback ? ` Feedback: ${args.feedback}` : " Proceed with implementation."}`
    : `Your plan has been REJECTED. Please revise and resubmit.${args.feedback ? ` Feedback: ${args.feedback}` : ""}`

  // Send approval/rejection message to teammate
  const msgId = sendMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: "lead",
    to: args.member,
    content: text,
  })

  await deps.client.session.promptAsync({
    path: { id: member.session_id },
    body: { parts: [{ type: "text", text: `[Plan ${args.approved ? "approved" : "rejected"} by lead]: ${text}` }] },
  })

  markDelivered(deps.db, msgId)

  return `Plan ${args.approved ? "approved" : "rejected"} for ${args.member}.${args.feedback ? ` Feedback: ${args.feedback}` : ""}`
}
