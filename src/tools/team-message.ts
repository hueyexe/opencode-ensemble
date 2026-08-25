import type { ToolDeps } from "../types"
import { resolveRecipientSession } from "../types"
import { requireTeamMember } from "./shared"
import { sendMessage, markDelivered, hasReportedCompletion } from "../messaging"
import { parseModelId, getMemberModel } from "../member-model"
import { log } from "../log"

/**
 * Execute the team_message tool. Sends a direct message to a teammate or lead.
 * Optionally approves or rejects a teammate's plan (lead only).
 * Optionally forces delivery to a teammate who already reported completion (lead only) —
 * see the `force` guard below.
 * Optionally updates a teammate's model in-place (lead only) via the `model`
 * param — see #26. When `model` is set, `text` is optional: if omitted, the
 * model is updated without delivering a message.
 */
export async function executeTeamMessage(
  deps: ToolDeps,
  args: { to: string; text?: string; approve?: boolean; reject?: string; force?: boolean; model?: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  if (args.force && teamInfo.role !== "lead") {
    throw new Error("Only the lead can force-deliver a message to a completed teammate.")
  }

  const senderName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  // In-place model update (lead only). Handled before recipient session
  // resolution so it works even when the member is idle/not in the registry,
  // and rejects terminal members explicitly. See #26.
  if (args.model !== undefined) {
    if (teamInfo.role !== "lead") throw new Error("Only the lead can update a teammate's model.")
    const parsed = parseModelId(args.model)
    if (!parsed) throw new Error(`Invalid model "${args.model}" — expected "provider/model" format (e.g. "anthropic/claude-sonnet").`)
    const member = deps.db.query("SELECT status FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamInfo.teamId, args.to) as { status: string } | null
    if (!member) throw new Error(`Teammate "${args.to}" not found in team "${teamInfo.teamName}".`)
    if (member.status === "shutdown" || member.status === "error") {
      throw new Error(`Teammate "${args.to}" is shut down — spawn a new teammate instead of updating the model.`)
    }
    deps.db.run(
      "UPDATE team_member SET model = ?, time_updated = ? WHERE team_id = ? AND name = ?",
      [args.model, Date.now(), teamInfo.teamId, args.to],
    )
    log(`team_message:model-update to=${args.to} model=${args.model}`)

    // If there's no accompanying message, we're done — the new model applies
    // on the teammate's next natural delivery.
    if (!args.text) {
      return `Updated ${args.to}'s model to ${args.model}. It applies on their next turn.`
    }
  }

  if (args.text === undefined) {
    throw new Error("team_message requires either 'text' or 'model'.")
  }
  const text = args.text

  const recipientSessionId = resolveRecipientSession(deps.db, deps.registry, teamInfo.teamId, args.to)

  // If recipient not found, store the message for later delivery (they may not be spawned yet)
  // Reject approve/reject flags for unspawned recipients — plan approval requires the member to exist
  if (!recipientSessionId && args.to !== "lead") {
    if (args.approve || args.reject) {
      throw new Error(`Cannot approve/reject plan for "${args.to}" — they haven't been spawned yet.`)
    }
    sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: senderName,
      to: args.to,
      content: text,
    })
    log(`team_message:queued from=${senderName} to=${args.to} (recipient not yet spawned)`)
    return `Message queued for ${args.to} — they haven't been spawned yet. It will be delivered when they join the team.`
  }
  if (!recipientSessionId) throw new Error(`Recipient "${args.to}" not found in team "${teamInfo.teamName}"`)

  // Handle plan approval/rejection
  let messageText = text
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

  // Guard: skip promptAsync delivery to teammates who have already reported completion (issue #3),
  // unless the lead explicitly forces it. Forcing wakes the session; the natural busy transition
  // (handleSessionStatusEvent) resets the completion flag when the teammate next goes idle, the
  // same reset that already happens for a normal re-activation — this just gives the lead a way
  // to trigger it deliberately instead of it being unreachable once the guard is set.
  if (hasReportedCompletion(deps.db, teamInfo.teamId, args.to) && !args.force) {
    return `Message stored for ${args.to} (teammate has completed their task — message will not wake them). Pass force:true to re-activate them.`
  }

  // For member-to-member messages, fire-and-forget delivery is safe.
  // Deliver on the recipient's configured model, if any (#26).
  const deliveryText = `[Team message from ${senderName}]: ${messageText}`
  const recipientModel = getMemberModel(deps.db, teamInfo.teamId, args.to)
  deps.client.session.promptAsync({
    sessionID: recipientSessionId,
    parts: [{ type: "text", text: deliveryText }],
    ...(recipientModel ? { model: recipientModel } : {}),
  }).then(() => {
    markDelivered(deps.db, msgId)
  }).catch((err) => {
    log(`team_message:deliver:failed to=${args.to} err=${err instanceof Error ? err.message : String(err)}`)
  })

  return `Message sent to ${args.to}.`
}
