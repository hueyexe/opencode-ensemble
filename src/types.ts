import type { Database } from "bun:sqlite"
import type { MemberRegistry, DescendantTracker } from "./state"

/**
 * Shared dependencies injected into every tool's execute function.
 * This avoids global state and makes tools testable with mocks.
 */
export interface ToolDeps {
  db: Database
  registry: MemberRegistry
  tracker: DescendantTracker
  /** The OpenCode SDK client — used for session.create, promptAsync, abort, etc. */
  client: PluginClient
  /** The project root directory — used for reading AGENTS.md and other project files. */
  directory: string
}

/** A single permission rule for session-level enforcement. */
export interface PermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

/**
 * Minimal interface for the OpenCode v2 SDK client methods we actually use.
 * Uses flat params matching the v2 SDK (imported from @opencode-ai/sdk/v2).
 * Makes mocking trivial in tests.
 */
export interface PluginClient {
  session: {
    create(options: {
      parentID?: string
      title?: string
      permission?: PermissionRule[]
      workspaceID?: string
      directory?: string
    }): Promise<{ data?: { id: string } }>
    promptAsync(options: {
      sessionID: string
      parts: Array<{ type: "text"; text: string }>
      model?: { providerID: string; modelID: string }
      agent?: string
      tools?: Record<string, boolean>
      system?: string
    }): Promise<unknown>
    abort(options: { sessionID: string }): Promise<unknown>
    status(): Promise<{ data?: Record<string, { type: string }> }>
  }
  tui: {
    showToast(options: {
      title?: string
      message?: string
      variant?: "info" | "success" | "warning" | "error"
      duration?: number
    }): Promise<unknown>
    selectSession(options: { sessionID?: string }): Promise<unknown>
  }
  worktree: {
    create(options: { worktreeCreateInput?: { name?: string; startCommand?: string } }): Promise<{ data?: { name: string; branch: string; directory: string } }>
    remove(options: { worktreeRemoveInput?: { directory: string } }): Promise<unknown>
    list(): Promise<{ data?: Array<{ name: string; branch: string; directory: string }> }>
    reset(options: { worktreeResetInput?: { directory: string } }): Promise<unknown>
  }
}

/**
 * Look up which team a session belongs to (as lead or member).
 * Returns team info or undefined.
 */
export function findTeamBySession(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
): { teamId: string; teamName: string; role: "lead" | "member"; memberName?: string } | undefined {
  // Check if session is a team member
  const entry = registry.getBySession(sessionId)
  if (entry) {
    const team = db.query("SELECT name FROM team WHERE id = ? AND status = 'active'").get(entry.teamId) as { name: string } | null
    if (team) return { teamId: entry.teamId, teamName: team.name, role: "member", memberName: entry.memberName }
  }

  // Check if session is a team lead
  const leadTeam = db.query("SELECT id, name FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionId) as { id: string; name: string } | null
  if (leadTeam) return { teamId: leadTeam.id, teamName: leadTeam.name, role: "lead" }

  return undefined
}

/**
 * Get the session ID for a recipient by name.
 * "lead" resolves to the team's lead_session_id.
 * Otherwise looks up the member registry.
 */
export function resolveRecipientSession(
  db: Database,
  registry: MemberRegistry,
  teamId: string,
  recipientName: string,
): string | undefined {
  if (recipientName === "lead") {
    const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId) as { lead_session_id: string } | null
    return team?.lead_session_id
  }
  const entry = registry.getByName(teamId, recipientName)
  return entry?.sessionId
}

/**
 * Get the lead's last-known agent mode for a team.
 * Returns undefined if never tracked (fallback to default behavior).
 */
export function getLeadAgent(db: Database, teamId: string): string | undefined {
  const row = db.query("SELECT lead_agent FROM team WHERE id = ?").get(teamId) as { lead_agent: string | null } | null
  return row?.lead_agent ?? undefined
}
