import type { ToolDeps } from "../types"
import { generateId, generateProjectName, validateProjectName, validateTeamName } from "../util"
import { findTeamBySession } from "../types"
import { isSessionAlive } from "../recovery"

/**
 * Execute the team_create tool. Creates a new team with the caller as lead.
 */
export async function executeTeamCreate(
  deps: ToolDeps,
  args: { name: string; project_name?: string },
  sessionId: string,
): Promise<string> {
  const nameError = validateTeamName(args.name)
  if (nameError) throw new Error(nameError)
  if (args.project_name) {
    const projectNameError = validateProjectName(args.project_name)
    if (projectNameError) throw new Error(projectNameError)
  }

  // Check if team name already exists
  const projectId = deps.directory
  const existing = deps.db.query("SELECT id, lead_session_id FROM team WHERE name = ? AND project_id = ? AND status = 'active'")
    .get(args.name, projectId) as { id: string; lead_session_id: string } | undefined
  if (existing) {
    // The existing team's lead session may have been deleted externally (via
    // OpenCode's own session UI/API, not team_cleanup) rather than genuinely
    // still being in use. Reconcile on demand rather than block this call on a
    // team nobody can ever be lead of again -- don't wait for the next plugin
    // restart's periodic recoverOrphanedTeams pass to notice.
    if (await isSessionAlive(deps.client, existing.lead_session_id)) {
      throw new Error(`Team "${args.name}" already exists`)
    }
    deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), existing.id])
    deps.registry.unregisterTeam(existing.id)
  }

  // Check if session already leads a team
  const lead = findTeamBySession(deps.db, deps.registry, sessionId)
  if (lead) throw new Error(`This session already belongs to team "${lead.teamName}"`)

  const id = generateId("team")
  const now = Date.now()
  const projectName = args.project_name ?? generateProjectName()
  deps.db.run(
    `INSERT INTO project (id, name, path, status, time_created, time_updated)
     VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated`,
    [projectId, projectName, projectId, now, now]
  )
  deps.db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)",
    [id, args.name, projectId, sessionId, now, now]
  )

  return `Team "${args.name}" created. You are the lead. Use team_spawn to add teammates.`
}
