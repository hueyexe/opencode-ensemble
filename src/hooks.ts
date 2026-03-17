import type { Database } from "bun:sqlite"
import type { MemberRegistry, DescendantTracker } from "./state"

const TEAM_TOOL_PREFIX = "team_"

/** Result of a session status event — tells the caller what transition happened. */
export interface StatusTransition {
  memberName: string
  teamId: string
  from: string
  to: string
}

/**
 * Handle a session.status event. Updates member status and execution_status
 * in SQLite based on the new session status.
 * Ignores events for unknown sessions or archived teams.
 * Returns the transition if one occurred, for toast notifications.
 */
export function handleSessionStatusEvent(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  status: "idle" | "busy" | "retry",
): StatusTransition | undefined {
  const entry = registry.getBySession(sessionId)
  if (!entry) return undefined

  // Check if team is archived — if so, silently ignore
  const team = db.query("SELECT status FROM team WHERE id = ?").get(entry.teamId) as { status: string } | null
  if (!team || team.status === "archived") return undefined

  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?")
    .get(entry.teamId, entry.memberName) as { status: string; execution_status: string } | null
  if (!member) return undefined

  if (status === "idle") {
    const newStatus = member.status === "shutdown_requested" ? "shutdown" : "ready"
    if (member.status === newStatus) return undefined
    db.run(
      "UPDATE team_member SET status = ?, execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
      [newStatus, Date.now(), entry.teamId, entry.memberName]
    )
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: newStatus }
  } else if (status === "busy") {
    if (member.status === "ready" || member.status === "error") {
      db.run(
        "UPDATE team_member SET status = 'busy', execution_status = 'running', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      )
      return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "busy" }
    }
    // Session went busy while shutdown was requested — signal for re-abort
    if (member.status === "shutdown_requested") {
      return { memberName: entry.memberName, teamId: entry.teamId, from: "shutdown_requested", to: "busy_while_shutdown" }
    }
  } else if (status === "retry") {
    // Session is being rate-limited — signal for toast but don't change state
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "retry" }
  }
  return undefined
}

/**
 * Handle a session.created event. Tracks the parent-child relationship
 * in the DescendantTracker for sub-agent isolation.
 */
export function handleSessionCreatedEvent(
  tracker: DescendantTracker,
  sessionId: string,
  parentId: string | undefined,
): void {
  if (parentId) {
    tracker.track(sessionId, parentId)
  }
}

/**
 * Check whether a tool call should be blocked for sub-agent isolation.
 * Throws if the tool is a team tool and the session is a descendant of a team member.
 * OQ-11: confirmed — throwing inside tool.execute.before fails the tool call gracefully (verified in live testing).
 */
export function checkToolIsolation(
  registry: MemberRegistry,
  tracker: DescendantTracker,
  toolName: string,
  sessionId: string,
): void {
  if (!toolName.startsWith(TEAM_TOOL_PREFIX)) return

  // If the session is a registered team member or lead, allow it
  if (registry.isTeamSession(sessionId)) return

  // Check if this session is a descendant of any team member
  const allTeamSessions = new Set<string>()
  for (const entry of registry["bySession"].keys()) {
    allTeamSessions.add(entry)
  }

  if (allTeamSessions.size > 0 && tracker.isDescendantOf(sessionId, allTeamSessions)) {
    throw new Error("Team tools are not available to sub-agents. Report findings to your parent teammate via your normal output.")
  }
}
