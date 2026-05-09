import type { ToolDeps } from "../types"
import { requireLead, requireCanPurgeArchivedTeams, checkWorktreeDirty } from "./shared"
import type { IsDirtyFn } from "./shared"
import { spawnFailures } from "./team-spawn"
import { mergeBranch, deleteBranch, preserveBranch, preservedBranchName, getOverlappingFiles } from "./merge-helper"
import type { MergeBranchFn, DeleteBranchFn, PreserveBranchFn, OverlapCheckFn } from "./merge-helper"
import { log } from "../log"

type PurgeApprovalFn = (preview: string) => Promise<void>
type ListBranchesFn = (teamName: string, cwd: string) => Promise<string[]>
type BranchExistsFn = (branch: string, cwd: string) => Promise<boolean>

interface PurgeTarget {
  id: string
  name: string
  time_updated: number
}

interface PurgeStats extends PurgeTarget {
  members: number
  tasks: number
  messages: number
  branches: number
  staleResources: number
  staleBranches: number
}

interface PurgeMemberResource {
  team_id: string
  team_name: string
  member_name: string
  worktree_dir: string | null
  workspace_id: string | null
  worktree_branch: string | null
}

async function listPreservedBranches(teamName: string, cwd: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(["git", "branch", "--list", `ensemble/preserved/${teamName}/*`, "--format", "%(refname:short)"], { cwd, stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exit = await proc.exited
    if (exit !== 0) throw new Error(stderr.trim() || `git branch exited with code ${exit}`)
    return out.split("\n").map(branch => branch.trim()).filter(Boolean)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("not a git repository")) return []
    throw new Error(`Failed to list preserved branches for ${teamName}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function branchExists(branch: string, cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "branch", "--list", branch, "--format", "%(refname:short)"], { cwd, stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exit = await proc.exited
    if (exit !== 0) {
      if (stderr.includes("not a git repository")) return false
      throw new Error(stderr.trim() || `git branch exited with code ${exit}`)
    }
    return out.split("\n").map(item => item.trim()).includes(branch)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("not a git repository")) return false
    throw new Error(`Failed to check stale Ensemble branch ${branch}: ${message}`)
  }
}

function normalizeBranchName(branch: string): string {
  return branch.trim().replace(/^\*\s*/, "")
}

function resolvePurgeTargets(deps: ToolDeps, purge: string[]): PurgeTarget[] {
  if (purge.length === 0) throw new Error("Pass at least one archived team name to purge, or ['*'] for all archived teams.")
  if (purge.includes("*") && purge.length !== 1) {
    throw new Error("Wildcard purge cannot be combined with explicit team names. Use purge: ['*'] by itself.")
  }

  if (purge.includes("*")) {
    return deps.db.query("SELECT id, name, time_updated FROM team WHERE status = 'archived' ORDER BY time_updated DESC, name ASC")
      .all() as PurgeTarget[]
  }

  const uniqueNames = [...new Set(purge)]
  const rows = uniqueNames.map(name => ({
    name,
    team: deps.db.query("SELECT id, name, status, time_updated FROM team WHERE name = ?").get(name) as { id: string; name: string; status: string; time_updated: number } | null,
  }))

  const missing = rows.filter(row => row.team === null).map(row => row.name)
  if (missing.length > 0) throw new Error(`Team not found: ${missing.join(", ")}`)

  const active = rows.filter(row => row.team?.status === "active").map(row => row.name)
  if (active.length > 0) throw new Error(`Cannot purge active team: ${active.join(", ")}`)

  return rows
    .map(row => row.team!)
    .sort((a, b) => b.time_updated - a.time_updated || a.name.localeCompare(b.name))
}

function deleteArchivedTeams(deps: ToolDeps, targets: PurgeTarget[]): void {
  const transaction = deps.db.transaction((teams: PurgeTarget[]) => {
    teams.forEach(team => {
      const row = deps.db.query("SELECT status FROM team WHERE id = ?").get(team.id) as { status: string } | null
      if (!row) throw new Error(`Team not found: ${team.name}`)
      if (row.status === "active") throw new Error(`Cannot purge active team: ${team.name}`)
    })
    validatePurgeResources(deps, teams)
    teams.forEach(team => {
      deps.db.run("DELETE FROM team WHERE id = ? AND status = 'archived'", [team.id])
    })
  })
  transaction(targets)
  targets.forEach(team => {
    deps.registry.unregisterTeam(team.id)
    spawnFailures.delete(team.id)
  })
}

function getPurgeMemberResources(deps: ToolDeps, targets: PurgeTarget[]): PurgeMemberResource[] {
  return targets.flatMap(target => deps.db.query(
    `SELECT t.name as team_name,
            tm.team_id,
            tm.name as member_name,
            tm.worktree_dir,
            tm.workspace_id,
            tm.worktree_branch
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE tm.team_id = ?`
  ).all(target.id) as PurgeMemberResource[])
}

function preservedBranchPrefix(resource: PurgeMemberResource): string {
  return `ensemble/preserved/${resource.team_name}/`
}

function staleEnsembleBranchNames(resource: PurgeMemberResource): string[] {
  return [
    `ensemble-${resource.team_name}-${resource.member_name}`,
    `opencode/ensemble-${resource.team_name}-${resource.member_name}`,
  ]
}

function isPreservedBranch(resource: PurgeMemberResource): boolean {
  return resource.worktree_branch !== null && resource.worktree_branch.startsWith(preservedBranchPrefix(resource))
}

function isStaleEnsembleBranch(resource: PurgeMemberResource): boolean {
  return resource.worktree_branch !== null && staleEnsembleBranchNames(resource).includes(resource.worktree_branch)
}

function validatePurgeResources(deps: ToolDeps, targets: PurgeTarget[]): void {
  const resources = getPurgeMemberResources(deps, targets)
  const nonPreserved = resources.filter(resource =>
    resource.worktree_branch !== null && !isPreservedBranch(resource) && !isStaleEnsembleBranch(resource)
  )
  if (nonPreserved.length > 0) {
    const details = nonPreserved.map(resource => `${resource.team_name}/${resource.member_name} (${resource.worktree_branch})`).join(", ")
    throw new Error(`Cannot purge archived teams: ${details} has a non-preserved worktree branch or a branch outside its preserved namespace.`)
  }

  const activeResourceRefs = resources.flatMap(resource => {
    const worktreeRefs = resource.worktree_dir
      ? deps.db.query(
        `SELECT t.name as team_name, tm.name as member_name
         FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE t.status = 'active' AND tm.worktree_dir = ?`
      ).all(resource.worktree_dir) as Array<{ team_name: string; member_name: string }>
      : []
    const workspaceRefs = resource.workspace_id
      ? deps.db.query(
        `SELECT t.name as team_name, tm.name as member_name
         FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE t.status = 'active' AND tm.workspace_id = ?`
      ).all(resource.workspace_id) as Array<{ team_name: string; member_name: string }>
      : []
    return [
      ...worktreeRefs.map(ref => `${resource.team_name}/${resource.member_name} worktree is also referenced by active team ${ref.team_name}/${ref.member_name}`),
      ...workspaceRefs.map(ref => `${resource.team_name}/${resource.member_name} workspace is also referenced by active team ${ref.team_name}/${ref.member_name}`),
    ]
  })
  if (activeResourceRefs.length > 0) {
    throw new Error(`Cannot purge archived teams: ${[...new Set(activeResourceRefs)].join(", ")}.`)
  }
}

function collectStaleEnsembleBranches(deps: ToolDeps, targets: PurgeTarget[]): string[] {
  return [...new Set(
    getPurgeMemberResources(deps, targets)
      .filter(isStaleEnsembleBranch)
      .map(resource => resource.worktree_branch!)
  )]
}

function countStaleResourceRefs(deps: ToolDeps, target: PurgeTarget): number {
  return getPurgeMemberResources(deps, [target]).reduce(
    (count, resource) => count + (resource.worktree_dir ? 1 : 0) + (resource.workspace_id ? 1 : 0),
    0,
  )
}

function countStaleBranchRefs(deps: ToolDeps, target: PurgeTarget): number {
  return collectStaleEnsembleBranches(deps, [target]).length
}

async function existingWorktreeDirs(deps: ToolDeps, resources: PurgeMemberResource[]): Promise<Set<string>> {
  if (!resources.some(resource => resource.worktree_dir)) return new Set()
  try {
    const result = await deps.client.worktree.list()
    return new Set((result.data ?? []).map(worktree => worktree.directory))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot purge archived teams: failed to list worktrees before stale resource cleanup: ${message}`)
  }
}

async function existingWorkspaceIds(deps: ToolDeps, resources: PurgeMemberResource[]): Promise<Set<string>> {
  if (!resources.some(resource => resource.workspace_id)) return new Set()
  try {
    const result = await deps.client.workspace.list()
    return new Set((result.data ?? []).map(workspace => workspace.id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot purge archived teams: failed to list workspaces before stale resource cleanup: ${message}`)
  }
}

async function cleanupStalePurgeResources(deps: ToolDeps, targets: PurgeTarget[], isDirty: IsDirtyFn): Promise<void> {
  const resources = getPurgeMemberResources(deps, targets).filter(resource => resource.worktree_dir || resource.workspace_id)
  if (resources.length === 0) return

  const worktreeDirs = await existingWorktreeDirs(deps, resources)
  const workspaceIds = await existingWorkspaceIds(deps, resources)

  for (const resource of resources) {
    if (resource.workspace_id) {
      if (workspaceIds.has(resource.workspace_id)) {
        try {
          await deps.client.workspace.remove({ id: resource.workspace_id })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed to remove stale workspace for ${resource.team_name}/${resource.member_name}: ${message}`)
        }
      }
      deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [resource.team_id, resource.member_name])
    }

    if (resource.worktree_dir) {
      if (worktreeDirs.has(resource.worktree_dir)) {
        let dirty: boolean
        try {
          dirty = await isDirty(resource.worktree_dir)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Cannot purge archived teams: failed to check archived worktree for uncommitted changes at ${resource.worktree_dir}: ${message}`)
        }
        if (dirty) {
          throw new Error(`Cannot purge archived teams: ${resource.team_name}/${resource.member_name} has uncommitted changes in archived worktree ${resource.worktree_dir}.`)
        }
        try {
          await deps.client.worktree.remove({ worktreeRemoveInput: { directory: resource.worktree_dir } })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed to remove stale worktree for ${resource.team_name}/${resource.member_name}: ${message}`)
        }
      }
      deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [resource.team_id, resource.member_name])
    }
  }
}

async function deleteStaleEnsembleBranches(
  branches: string[],
  cwd: string,
  delBranch: DeleteBranchFn,
  exists: BranchExistsFn,
): Promise<void> {
  for (const branch of branches) {
    if (!await exists(branch, cwd)) continue
    const ok = await delBranch(branch, cwd)
    if (!ok) throw new Error(`Failed to delete stale Ensemble branch: ${branch}`)
  }
}

function validatePurgeTargetsStillArchived(deps: ToolDeps, targets: PurgeTarget[]): void {
  const missing: string[] = []
  const active: string[] = []
  targets.forEach(target => {
    const row = deps.db.query("SELECT status FROM team WHERE id = ?").get(target.id) as { status: string } | null
    if (!row) missing.push(target.name)
    else if (row.status === "active") active.push(target.name)
  })

  if (missing.length > 0) throw new Error(`Team not found: ${missing.join(", ")}`)
  if (active.length > 0) throw new Error(`Cannot purge active team: ${active.join(", ")}`)
}

async function collectPreservedBranches(
  targets: PurgeTarget[],
  cwd: string,
  listBranches: ListBranchesFn,
): Promise<Map<string, string[]>> {
  const entries: Array<[string, string[]]> = await Promise.all(targets.map(async target => {
    const prefix = `ensemble/preserved/${target.name}/`
    let listed: string[]
    try {
      listed = await listBranches(target.name, cwd)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("not a git repository")) listed = []
      else throw new Error(`Failed to list preserved branches for ${target.name}: ${message}`)
    }
    const branches = listed.map(normalizeBranchName).filter(branch => branch.startsWith(prefix))
    return [target.id, [...new Set(branches)]]
  }))
  return new Map(entries)
}

async function deletePreservedBranches(
  branchesByTeam: Map<string, string[]>,
  cwd: string,
  delBranch: DeleteBranchFn,
): Promise<void> {
  const branches = [...branchesByTeam.values()].flat()
  for (const branch of branches) {
    const ok = await delBranch(branch, cwd)
    if (!ok) throw new Error(`Failed to delete preserved branch: ${branch}`)
  }
}

function formatCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`
}

function buildPurgePreview(deps: ToolDeps, targets: PurgeTarget[], branchesByTeam: Map<string, string[]>): string {
  const rows = targets.map(target => {
    const members = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(target.id) as { c: number }).c
    const tasks = (deps.db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ?").get(target.id) as { c: number }).c
    const messages = (deps.db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ?").get(target.id) as { c: number }).c
    const branches = branchesByTeam.get(target.id)?.length ?? 0
    const staleResources = countStaleResourceRefs(deps, target)
    const staleBranches = countStaleBranchRefs(deps, target)
    return { ...target, members, tasks, messages, branches, staleResources, staleBranches }
  }) satisfies PurgeStats[]
  const totals = rows.reduce(
    (acc, row) => ({
      members: acc.members + row.members,
      tasks: acc.tasks + row.tasks,
      messages: acc.messages + row.messages,
      branches: acc.branches + row.branches,
      staleResources: acc.staleResources + row.staleResources,
      staleBranches: acc.staleBranches + row.staleBranches,
    }),
    { members: 0, tasks: 0, messages: 0, branches: 0, staleResources: 0, staleBranches: 0 }
  )
  const details = rows.slice(0, 10).map(row =>
    `- ${row.name}: ${formatCount(row.members, "member")}, ${formatCount(row.tasks, "task")}, ${formatCount(row.messages, "message")}, ${formatCount(row.branches, "preserved branch", "preserved branches")}, ${formatCount(row.staleResources, "stale resource")}, ${formatCount(row.staleBranches, "stale branch", "stale branches")}`
  )
  const hidden = rows.length > 10 ? [`...and ${rows.length - 10} more archived team${rows.length - 10 === 1 ? "" : "s"}`] : []

  return [
    "Permanently delete archived teams?",
    "This will delete archived team records and cascade-delete their members, tasks, and messages.",
    "",
    ...details,
    ...hidden,
    "",
    `Total: ${formatCount(rows.length, "team")}, ${formatCount(totals.members, "member")}, ${formatCount(totals.tasks, "task")}, ${formatCount(totals.messages, "message")}, ${formatCount(totals.branches, "preserved branch", "preserved branches")}, ${formatCount(totals.staleResources, "stale resource")}, ${formatCount(totals.staleBranches, "stale branch", "stale branches")}`,
  ].join("\n")
}

function buildPurgeConfirmationInstructions(preview: string, confirmToken: string): string {
  const approvalLabel = `Approve purge ${confirmToken.slice(0, 8)}`
  const denialLabel = `Deny purge ${confirmToken.slice(0, 8)}`
  return [
    "Purge preview only — no teams were deleted.",
    "",
    preview,
    "",
    "Use the question tool to ask the user whether to permanently delete these archived teams.",
    `The approval option label must be exactly: ${approvalLabel}`,
    `The denial option label must be exactly: ${denialLabel}`,
    `Confirmation token: ${confirmToken}`,
    `Only if the user selects "${approvalLabel}", call team_cleanup again with the same purge value, confirm_purge: true, and confirm_token set to this token.`,
  ].join("\n")
}

/**
 * Execute the team_cleanup tool. Archives the team and cleans up resources.
 * Acts as a safety net: merges any remaining unmerged preserved branches
 * that the lead forgot to merge with team_merge.
 */
export async function executeTeamCleanup(
  deps: ToolDeps,
  args: { force: boolean; acknowledge_uncommitted?: boolean; purge?: string[]; confirm_purge?: boolean; confirm_token?: string },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  mergeOnCleanup = true,
  overlapCheck: OverlapCheckFn = getOverlappingFiles,
  _approvePurge?: PurgeApprovalFn,
  _listBranches?: ListBranchesFn,
  _branchExists?: BranchExistsFn,
): Promise<string> {
  if (args.purge && args.purge.length > 0) {
    requireCanPurgeArchivedTeams(deps, sessionId)
    const targets = resolvePurgeTargets(deps, args.purge)
    if (targets.length === 0) return "No archived teams to purge."

    validatePurgeTargetsStillArchived(deps, targets)
    validatePurgeResources(deps, targets)
    const branchesByTeam = await collectPreservedBranches(targets, deps.directory, _listBranches ?? listPreservedBranches)
    const preview = buildPurgePreview(deps, targets, branchesByTeam)
    if (!args.confirm_purge) {
      const confirmToken = deps.purgeApprovals.create(sessionId, targets.map(target => target.id))
      return buildPurgeConfirmationInstructions(preview, confirmToken)
    }

    if (!args.confirm_token) {
      throw new Error("A purge confirmation token is required. First call team_cleanup without confirm_purge, then use the question tool before confirming.")
    }
    deps.purgeApprovals.consume(sessionId, args.confirm_token, targets.map(target => target.id))

    validatePurgeTargetsStillArchived(deps, targets)
    validatePurgeResources(deps, targets)
    await cleanupStalePurgeResources(deps, targets, isDirty)

    validatePurgeResources(deps, targets)
    await deleteStaleEnsembleBranches(collectStaleEnsembleBranches(deps, targets), deps.directory, delBranch, _branchExists ?? branchExists)
    const finalBranchesByTeam = await collectPreservedBranches(targets, deps.directory, _listBranches ?? listPreservedBranches)
    await deletePreservedBranches(finalBranchesByTeam, deps.directory, delBranch)

    deleteArchivedTeams(deps, targets)

    const noun = targets.length === 1 ? "archived team" : "archived teams"
    return `Permanently deleted ${targets.length} ${noun}: ${targets.map(target => target.name).join(", ")}.`
  }

  const teamInfo = requireLead(deps, sessionId)

  const members = deps.db.query("SELECT name, session_id, status, worktree_dir, worktree_branch, workspace_id FROM team_member WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ name: string; session_id: string; status: string; worktree_dir: string | null; worktree_branch: string | null; workspace_id: string | null }>

  const active = members.filter(m => m.status !== "shutdown" && m.status !== "shutdown_requested" && m.status !== "error")

  if (active.length > 0 && !args.force) {
    const names = active.map(m => m.name).join(", ")
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`)
  }

  // Check for uncommitted changes BEFORE aborting sessions
  if (!args.acknowledge_uncommitted) {
    const dirty: Array<{ name: string; branch: string }> = []
    for (const member of members) {
      if (member.worktree_dir) {
        try {
          if (await isDirty(member.worktree_dir)) {
            dirty.push({ name: member.name, branch: member.worktree_branch ?? "unknown" })
          }
        } catch {
          log(`cleanup:dirty-check:failed name=${member.name}`)
        }
      }
    }
    if (dirty.length > 0) {
      const warnings = dirty.map(d => `  - ${d.name} (branch: ${d.branch})`).join("\n")
      return `Warning: ${dirty.length} teammate(s) have uncommitted changes in their worktrees:\n${warnings}\n\nCommit or merge their work first, then call team_cleanup with acknowledge_uncommitted: true to proceed.`
    }
  }

  // Force-abort active members — preserve branches BEFORE aborting
  if (args.force) {
    for (const member of active) {
      // Preserve branch before abort — session.abort() may destroy the worktree + branch
      if (member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(teamInfo.teamName, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, deps.directory)
        if (ok) {
          deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, teamInfo.teamId, member.name])
          member.worktree_branch = safeBranch
        }
      }
      try {
        await deps.client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }
    }
  }

  // Safety net: merge any remaining unmerged preserved branches
  const unmerged = members.filter(m => m.worktree_branch !== null)
  const merged: string[] = []
  const conflicted: string[] = []
  const overlapWarnings: string[] = []

  if (unmerged.length > 0 && mergeOnCleanup) {
    for (const member of unmerged) {
      const branch = member.worktree_branch!
      // Warn (but don't block) if lead has local changes to overlapping files
      try {
        const overlap = await overlapCheck(branch, deps.directory)
        if (overlap.length > 0) {
          overlapWarnings.push(`${member.name}: ${overlap.join(", ")}`)
        }
      } catch { /* best effort */ }
      const result = await merge(branch, deps.directory)
      if (result.ok) {
        await delBranch(branch, deps.directory)
        deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
        merged.push(`${member.name} (${branch})`)
      } else {
        log(`cleanup:merge:conflict member=${member.name} branch=${branch} err=${result.error}`)
        conflicted.push(`${member.name} (${branch})`)
      }
    }
  }

  // Remove workspaces and worktrees
  for (const member of members) {
    if (member.workspace_id) {
      try {
        await deps.client.workspace.remove({ id: member.workspace_id })
        deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort */ }
    }
    if (member.worktree_dir) {
      try {
        await deps.client.worktree.remove({ worktreeRemoveInput: { directory: member.worktree_dir } })
        deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort */ }
    }
  }

  // Archive team
  deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), teamInfo.teamId])

  // Clean up in-memory state
  deps.registry.unregisterTeam(teamInfo.teamId)
  spawnFailures.delete(teamInfo.teamId)

  // Build response
  const parts: string[] = [`Team "${teamInfo.teamName}" cleaned up.`]
  if (merged.length > 0) {
    parts.push(`Safety-net merged ${merged.length} unmerged branch(es): ${merged.join(", ")}. Review with: git diff`)
  }
  if (conflicted.length > 0) {
    parts.push(`Could not auto-merge: ${conflicted.join(", ")}. Merge manually.`)
  }
  if (overlapWarnings.length > 0) {
    parts.push(`Warning: safety-net merge overwrote local changes to overlapping files:\n${overlapWarnings.map(w => `  - ${w}`).join("\n")}\nReview with: git diff`)
  }
  return parts.join("\n")
}
