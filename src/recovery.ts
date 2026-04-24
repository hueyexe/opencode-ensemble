import type { Database } from "bun:sqlite"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import { getUndeliveredMessages, markDelivered, hasReportedCompletion } from "./messaging"
import { preserveBranch, preservedBranchName } from "./tools/merge-helper"
import { log } from "./log"

/**
 * Scan for team members stuck in 'busy' status (stale from a crash)
 * and mark them as 'error' with execution_status 'idle'.
 * Preserves worktree branches before aborting orphaned sessions.
 * Only processes members in active teams.
 * Returns the count of interrupted members.
 */
export async function recoverStaleMembers(db: Database, client?: PluginClient, cwd?: string): Promise<{ interrupted: number }> {
  // Find stale members with branch info so we can preserve before aborting
  const stale = db.query(
    `SELECT tm.session_id, tm.worktree_branch, tm.name, tm.team_id, t.name as team_name
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE tm.status = 'busy' AND t.status = 'active'`
  ).all() as Array<{ session_id: string; worktree_branch: string | null; name: string; team_id: string; team_name: string }>

  const result = db.run(
    `UPDATE team_member SET status = 'error', execution_status = 'idle', time_updated = ?
     WHERE status = 'busy'
       AND team_id IN (SELECT id FROM team WHERE status = 'active')`,
    [Date.now()]
  )

  // Preserve branches then abort orphaned sessions
  if (client) {
    for (const member of stale) {
      // Preserve branch BEFORE abort — session.abort() may destroy the worktree + branch
      if (cwd && member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(member.team_name, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, cwd)
        if (ok) {
          db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, member.team_id, member.name])
          log(`recovery:branch:preserved src=${member.worktree_branch} target=${safeBranch}`)
        }
      }
      try {
        await client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }
    }
  }

  return { interrupted: result.changes }
}

/**
 * Clean up orphaned worktrees from archived teams or members that no longer exist.
 * Compares worktrees on disk (via client.worktree.list) against active team members.
 */
export async function recoverOrphanedWorktrees(db: Database, client: PluginClient): Promise<{ removed: number }> {
  let removed = 0

  try {
    const worktrees = await client.worktree.list()
    if (!worktrees.data) return { removed: 0 }

    // Get all active worktree directories from the DB
    const activeWorktrees = new Set(
      (db.query(
        `SELECT tm.worktree_dir FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE tm.worktree_dir IS NOT NULL AND t.status = 'active'`
      ).all() as Array<{ worktree_dir: string }>).map(r => r.worktree_dir)
    )

    for (const wt of worktrees.data) {
      // Only clean up worktrees created by ensemble (name starts with "ensemble-")
      if (!wt.name.startsWith("ensemble-")) continue
      if (activeWorktrees.has(wt.directory)) continue

      try {
        await client.worktree.remove({ worktreeRemoveInput: { directory: wt.directory } })
        removed++
      } catch { /* best effort */ }
    }
  } catch {
    // worktree.list may not be available — silently ignore
  }

  return { removed }
}

/**
 * Redeliver undelivered messages (delivered=0) via promptAsync.
 * Resolves recipient session IDs from the member registry or team lead.
 * Continues on partial failure — logs but doesn't abort.
 */
export async function recoverUndeliveredMessages(
  db: Database,
  client: PluginClient,
  registry: MemberRegistry,
): Promise<{ redelivered: number }> {
  // Get all active teams
  const teams = db.query("SELECT id, lead_session_id FROM team WHERE status = 'active'")
    .all() as Array<{ id: string; lead_session_id: string }>

  let redelivered = 0

  for (const team of teams) {
    const messages = getUndeliveredMessages(db, team.id)

    for (const msg of messages) {
      // Resolve recipient session ID
      let recipientSessionId: string | undefined

      if (msg.to_name === "lead") {
        // Skip lead-bound messages — the system prompt transform delivers them
        continue
      } else if (msg.to_name) {
        const entry = registry.getByName(team.id, msg.to_name)
        recipientSessionId = entry?.sessionId
      } else {
        // Broadcast — skip for now, broadcasts are best-effort
        continue
      }

      if (!recipientSessionId) continue

      // Skip delivery to teammates who have already reported completion (issue #3)
      if (hasReportedCompletion(db, team.id, msg.to_name!)) {
        markDelivered(db, msg.id)
        continue
      }

      try {
        await client.session.promptAsync({
          sessionID: recipientSessionId,
          parts: [{ type: "text", text: `[Recovered team message from ${msg.from_name}]: ${msg.content}` }],
        })
        markDelivered(db, msg.id)
        redelivered++
      } catch {
        // Continue on failure — message stays undelivered for next recovery
      }
    }
  }

  return { redelivered }
}

/**
 * Clean up orphaned ensemble/preserved/* branches that belong to archived teams
 * with no active members. Scoped carefully to avoid interfering with other
 * running OpenCode sessions that may have active teams.
 */
export async function recoverOrphanedBranches(db: Database, cwd: string): Promise<{ removed: number }> {
  let removed = 0

  // Get archived team names that have NO active members
  const archivedTeams = db.query(
    `SELECT t.name FROM team t
     WHERE t.status = 'archived'
     AND NOT EXISTS (
       SELECT 1 FROM team_member tm
       WHERE tm.team_id = t.id AND tm.status NOT IN ('shutdown', 'error')
     )`
  ).all() as Array<{ name: string }>

  if (archivedTeams.length === 0) return { removed: 0 }

  const archivedNames = new Set(archivedTeams.map(t => t.name))

  // List all local branches matching ensemble/preserved/*
  const proc = Bun.spawn(["git", "branch", "--list", "ensemble/preserved/*"], { cwd, stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(proc.stdout).text()
  await proc.exited
  const stdout = await stdoutPromise

  const branches = stdout.split("\n").map(b => b.trim().replace(/^\* /, "")).filter(Boolean)

  for (const branch of branches) {
    // Parse team name from branch: ensemble/preserved/{teamName}/{memberName}
    const parts = branch.split("/")
    if (parts.length < 4) continue
    const teamName = parts[2]
    if (!teamName || !archivedNames.has(teamName)) continue

    try {
      const del = Bun.spawn(["git", "branch", "-D", branch], { cwd, stdout: "pipe", stderr: "pipe" })
      const exitCode = await del.exited
      if (exitCode === 0) {
        removed++
        log(`recovery:branch:deleted branch=${branch}`)
      }
    } catch { /* best effort */ }
  }

  return { removed }
}
