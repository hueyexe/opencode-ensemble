import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import { getUndeliveredMessages, markDelivered, hasReportedCompletion } from "./messaging"
import { releaseMemberTasks } from "./tasks"
import { getMemberModel } from "./member-model"
import { preserveBranch, preservedBranchName, teamResourceSegment } from "./tools/merge-helper"
import { log } from "./log"
import { runCommand } from "./process"

/**
 * Whether a session still exists in OpenCode. `client.session.get` throws for a
 * deleted/unknown session rather than returning empty data -- see dashboard.ts's
 * existing best-effort usage of the same call.
 *
 * Bounded by a timeout: a `session.get` call made from within this plugin's own
 * init sequence, before the server has finished bootstrapping, can hang the
 * request indefinitely rather than resolve or reject -- the same class of
 * self-referential-HTTP-call deadlock team-spawn.ts's own `withTimeout` exists
 * to guard against for `worktree.create`/`session.create` ("makes HTTP calls
 * back to the server, which deadlocks because the server is still handling
 * session.create"). On timeout, treat liveness as UNKNOWN (return true, i.e.
 * "assume alive, don't archive") rather than assuming dead -- a false negative
 * here just means the orphan isn't reconciled this pass; a false positive means
 * archiving a team that might still be genuinely active.
 */
export async function isSessionAlive(client: PluginClient, sessionId: string, timeoutMs = 5000): Promise<boolean> {
  try {
    await Promise.race([
      client.session.get({ sessionID: sessionId }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("isSessionAlive timed out")), timeoutMs)),
    ])
    return true
  } catch (err) {
    if (err instanceof Error && err.message === "isSessionAlive timed out") {
      log(`recovery:team:liveness-check-timeout session=${sessionId}`)
      return true
    }
    return false
  }
}

/**
 * Reconcile 'active' teams whose lead session no longer exists in OpenCode --
 * e.g. the user deleted the session via OpenCode's own session UI/API, not via
 * team_cleanup. Ensemble's own bookkeeping has no way to learn about that on its
 * own: nothing tells it the session is gone, so the team row stays 'active'
 * forever, blocking team_create ("already exists") and team_cleanup's purge path
 * ("cannot purge active team" -- purge only operates on archived teams) for that
 * name indefinitely. A team with no live lead session is unrecoverable through
 * any legitimate path (there is no "reassign lead" tool), so archiving it directly
 * is safe regardless of member state -- the existing recoverOrphanedWorktrees/
 * recoverOrphanedBranches passes then naturally sweep up its resources on the same
 * recovery cycle, since those already scope to archived teams with no active
 * members.
 *
 * Scoped by cwd the same way recoverStaleMembers is, to avoid reconciling other
 * projects' teams when multiple projects share one DB.
 */
export async function recoverOrphanedTeams(
  db: Database,
  client: PluginClient,
  cwd?: string,
  registry?: MemberRegistry,
): Promise<{ archived: number }> {
  const active = db.query(
    `SELECT id, lead_session_id FROM team
     WHERE status = 'active' AND (? IS NULL OR project_id = ? OR project_id = 'default')`
  ).all(cwd ?? null, cwd ?? null) as Array<{ id: string; lead_session_id: string }>

  let archived = 0
  for (const team of active) {
    if (await isSessionAlive(client, team.lead_session_id)) continue

    db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), team.id])
    registry?.unregisterTeam(team.id)
    archived++
    log(`recovery:team:orphaned team_id=${team.id} lead_session=${team.lead_session_id}`)
  }

  return { archived }
}

/**
 * Scan for team members stuck in 'busy' status (stale from a crash)
 * and mark them as 'error' with execution_status 'idle'.
 * Preserves worktree branches before aborting orphaned sessions.
 * Only processes members in active teams.
 * Returns the count of interrupted members.
 *
 * `abortTimeoutMs` bounds each `client.session.abort()` call -- the same
 * self-referential-HTTP-call-back-to-this-server shape as
 * `isSessionAlive()`'s `client.session.get()` (see that function's doc
 * comment for the full deadlock mechanism, confirmed live 2026-08-17). This
 * function is awaited synchronously in plugin init (unlike
 * `recoverOrphanedTeams`, which is fire-and-forget) because
 * `rehydrateRegistry` depends on it completing first, so a bounded timeout on
 * the network call -- not restructuring the await -- is the fix here: the
 * DB-only work (marking members 'error') always completes and is reflected in
 * the returned count regardless of whether any individual abort call settles.
 */
export async function recoverStaleMembers(db: Database, client?: PluginClient, cwd?: string, abortTimeoutMs = 5000): Promise<{ interrupted: number }> {
  // Find stale members with branch info so we can preserve before aborting
  const stale = db.query(
    `SELECT tm.session_id, tm.worktree_branch, tm.name, tm.team_id, t.name as team_name, p.name as project_name
      FROM team_member tm
      JOIN team t ON tm.team_id = t.id
      JOIN project p ON t.project_id = p.id
      WHERE tm.status = 'busy' AND t.status = 'active'
        AND (? IS NULL OR t.project_id = ? OR t.project_id = 'default')`
  ).all(cwd ?? null, cwd ?? null) as Array<{ session_id: string; worktree_branch: string | null; name: string; team_id: string; team_name: string; project_name: string }>

  const result = db.run(
    `UPDATE team_member SET status = 'error', execution_status = 'idle', time_updated = ?
      WHERE status = 'busy'
        AND team_id IN (SELECT id FROM team WHERE status = 'active' AND (? IS NULL OR project_id = ? OR project_id = 'default'))`,
    [Date.now(), cwd ?? null, cwd ?? null]
  )

  // Release each stale member's in_progress tasks back to the pool so their
  // unfinished work is reclaimable after a crash (issue #27).
  for (const member of stale) {
    const released = releaseMemberTasks(db, member.team_id, member.name)
    if (released > 0) log(`recovery:tasks:released name=${member.name} count=${released}`)
  }

  // Preserve branches then abort orphaned sessions
  if (client) {
    for (const member of stale) {
      // Preserve branch BEFORE abort — session.abort() may destroy the worktree + branch
      if (cwd && member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(member.project_name, member.team_name, member.team_id, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, cwd)
        if (ok) {
          db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, member.team_id, member.name])
          log(`recovery:branch:preserved src=${member.worktree_branch} target=${safeBranch}`)
        }
      }
      try {
        await Promise.race([
          client.session.abort({ sessionID: member.session_id }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session.abort timed out")), abortTimeoutMs)),
        ])
      } catch (err) {
        if (err instanceof Error && err.message === "session.abort timed out") {
          log(`recovery:stale-members:abort-timeout session=${member.session_id}`)
        }
        /* best effort */
      }
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
        const recipientModel = getMemberModel(db, team.id, msg.to_name)
        await client.session.promptAsync({
          sessionID: recipientSessionId,
          parts: [{ type: "text", text: `[Recovered team message from ${msg.from_name}]: ${msg.content}` }],
          ...(recipientModel ? { model: recipientModel } : {}),
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
 * Repopulate the in-memory MemberRegistry from SQLite for all active members.
 * MUST be called on every plugin init — the registry is in-memory only,
 * and without rehydration, every team_* tool call from an existing
 * teammate fails with "This session is not in a team." after a plugin restart.
 *
 * Skips members in terminal states (shutdown, error) — they should not
 * receive future messages.
 *
 * Returns the number of members rehydrated.
 */
export function rehydrateRegistry(db: Database, registry: MemberRegistry): number {
  const members = db.query(
    `SELECT tm.team_id, tm.name, tm.session_id
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active' AND tm.status NOT IN ('shutdown', 'error')`
  ).all() as Array<{ team_id: string; name: string; session_id: string }>
  for (const m of members) {
    registry.register(m.team_id, m.name, m.session_id)
  }
  return members.length
}

/**
 * Clean up orphaned ensemble/preserved/* branches that belong to archived teams
 * with no active members. Scoped carefully to avoid interfering with other
 * running OpenCode sessions that may have active teams.
 */
export async function recoverOrphanedBranches(db: Database, cwd: string): Promise<{ removed: number }> {
  let removed = 0

  // Get archived team namespaces for this project that have NO active members.
  // The team id namespace is current; team names are kept for legacy preserved branches.
  const archivedTeams = db.query(
    `SELECT t.id, t.name, p.name as project_name FROM team t
     JOIN project p ON t.project_id = p.id
     WHERE t.status = 'archived'
      AND t.project_id = ?
     AND NOT EXISTS (
        SELECT 1 FROM team_member tm
        WHERE tm.team_id = t.id AND tm.status NOT IN ('shutdown', 'error')
      )`
  ).all(cwd) as Array<{ id: string; name: string; project_name: string }>

  if (archivedTeams.length === 0) return { removed: 0 }

  const archivedPrefixes = archivedTeams.flatMap(t => [
    `ensemble/preserved/${t.project_name}/${teamResourceSegment(t.name, t.id)}/`,
    `ensemble/preserved/${t.name}/`,
  ])

  // List all local branches matching ensemble/preserved/*
  const result = await runCommand(["git", "branch", "--list", "ensemble/preserved/*"], { cwd })

  const branches = result.stdout.split("\n").map(b => b.trim().replace(/^\* /, "")).filter(Boolean)

  for (const branch of branches) {
    if (!archivedPrefixes.some(prefix => branch.startsWith(prefix))) continue

    try {
      const deleteResult = await runCommand(["git", "branch", "-D", branch], { cwd })
      if (deleteResult.exitCode === 0) {
        removed++
        log(`recovery:branch:deleted branch=${branch}`)
      }
    } catch { /* best effort */ }
  }

  return { removed }
}
