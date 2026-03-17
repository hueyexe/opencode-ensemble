import type { ToolDeps } from "../types"
import { generateId, validateTeamName } from "../util"
import { findTeamBySession } from "../types"

/**
 * Execute the team_create tool. Creates a new team with the caller as lead.
 */
export async function executeTeamCreate(
  deps: ToolDeps,
  args: { name: string },
  sessionId: string,
): Promise<string> {
  const nameError = validateTeamName(args.name)
  if (nameError) throw new Error(nameError)

  // Check if team name already exists
  const existing = deps.db.query("SELECT id FROM team WHERE name = ? AND status = 'active'").get(args.name)
  if (existing) throw new Error(`Team "${args.name}" already exists`)

  // Check if session already leads a team
  const lead = findTeamBySession(deps.db, deps.registry, sessionId)
  if (lead) throw new Error(`This session already belongs to team "${lead.teamName}"`)

  const id = generateId("team")
  const now = Date.now()
  deps.db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    [id, args.name, sessionId, now, now]
  )

  return `Team "${args.name}" created. You are the lead. Use team_spawn to add teammates.`
}
