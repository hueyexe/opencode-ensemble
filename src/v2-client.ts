import { realpath } from "node:fs/promises"
import type { PermissionRule, PluginClient } from "./types"
import { vlog } from "./log"
import { runCommand } from "./process"

type SessionInfo = {
  id: string
  projectID?: string
  location?: { directory?: string; workspaceID?: string }
}

/** V2 plugin context subset Ensemble needs (structural, mock-friendly). */
export interface V2Context {
  /** Plugin location; `project.id` is required by the 2.0.19+ worktree API. */
  location?: { directory?: string; project?: { id?: string } }
  session: {
    create(input: Record<string, unknown>): Promise<SessionInfo>
    move?(input: { sessionID: string; directory: string; delivery: "queue" }): Promise<unknown>
    wait?(input: { sessionID: string }): Promise<unknown>
    remove?(input: { sessionID: string }): Promise<unknown>
    prompt(input: Record<string, unknown>): Promise<unknown>
    switchAgent(input: Record<string, unknown>): Promise<unknown>
    switchModel(input: Record<string, unknown>): Promise<unknown>
    interrupt(input: Record<string, unknown>): Promise<unknown>
    get(input: Record<string, unknown>): Promise<unknown>
    context(input: Record<string, unknown>): Promise<unknown[]>
    active(): Promise<Record<string, { type: string }>>
    synthetic(input: Record<string, unknown>): Promise<unknown>
  }
  worktree: {
    create(input: Record<string, unknown>): Promise<{ directory: string }>
    remove(input: Record<string, unknown>): Promise<unknown>
    list(input?: Record<string, unknown>): Promise<Array<{ directory: string }>>
    refresh(input?: Record<string, unknown>): Promise<unknown>
  }
  permission: {
    /** Present on 2.0.3–2.0.18 only; removed in 2.0.19 (see issue #40). */
    rules?(input: Record<string, unknown>): Promise<unknown>
  }
  /** Agent lookup (2.0.19+): exposes each agent's resolved permission rules. */
  agent?: {
    get(input: Record<string, unknown>): Promise<unknown>
  }
}

type PermissionRuleV2 = { action?: unknown; resource?: unknown; effect?: unknown }

/** OpenCode wildcard match: `*` matches any run of characters. */
function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/**
 * True when an agent's own rules deny editing everywhere. OpenCode evaluates
 * the last matching rule, so this mirrors `evaluate("edit", "*")` over the
 * agent ruleset. Undefined when the rules carry no edit decision.
 */
export function agentRulesAreReadOnly(rules: unknown): boolean | undefined {
  if (!Array.isArray(rules)) return undefined
  const match = [...(rules as PermissionRuleV2[])].reverse().find((rule) =>
    typeof rule?.action === "string" && typeof rule?.resource === "string"
    && wildcardMatch("edit", rule.action) && (rule.resource === "*" || rule.resource === "**"))
  if (!match) return undefined
  return match.effect === "deny"
}

/** Optional companion integration. */
export interface V2ClientDeps {
  /** RPC emitter for companion events (team_view navigation). */
  rpcEmitter?: { events: { emit(name: string, data: unknown): Promise<unknown> } }
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd: directory })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in "${directory}" failed: ${result.stderr.trim() || result.exitCode}`)
  }
  return result.stdout.trimEnd()
}

async function gitWorktrees(directory: string): Promise<Array<string | undefined>> {
  const paths = (await git(directory, "worktree", "list", "--porcelain", "-z"))
    .split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9))
  // Git emits forward slashes on Windows. Resolve both SDK and Git paths
  // the same way, ignoring stale worktree entries whose paths no longer exist.
  return Promise.all(paths.map((path) => realpath(path).catch(() => undefined)))
}

async function sessionIsIn(info: SessionInfo | undefined, directory: string): Promise<boolean> {
  if (!info?.location?.directory || info.location.workspaceID) return false
  return await realpath(info.location.directory).catch(() => undefined) === directory
}

/** Concatenate the text parts of a promptAsync payload into one string. */
function joinParts(parts: Array<{ type: "text"; text: string }>): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/**
 * Adapt a V2 plugin context to the shared PluginClient interface so all 14
 * team tools can use the same client on both hosts.
 *
 * Mapping notes (all spike-verified live against v2.0.3 unless marked OQ):
 * - create: V1 `permission` rules become V2 `{action, resource, effect}`;
 *   `workspaceID`/`directory` nest under `location`.
 * - promptAsync: queue delivery wakes idle sessions; `agent` is applied via
 *   switchAgent first (V2 binds the agent at create/admission, and the shared
 *   create signature has no agent slot — only spawn passes one).
 * - abort: interrupt. status: derived from the active set — sessions absent
 *   from it read as idle, which matches the shutdown default (team-shutdown
 *   treats unknown as idle). OQ-V2-status: if V2 ever reports non-running
 *   states here, extend the mapping.
 * - tui.*: no-op. Toasts and session-select move to the CLI (`./tui`) plugin
 *   in a later phase — the server plugin must not depend on a TUI.
 * - createIsolatedSession: V2 spawn provisions the worktree from the lead's
 *   session location and verifies the child's location before returning it.
 * - worktree.list: V2 entries carry directory only; name is the basename
 *   (recovery filters on the `ensemble-` prefix — a non-matching dir is
 *   skipped, never wrongly deleted). reset has no production callers and
 *   maps to refresh. OQ-V2-wtname.
 * - Worktree and workspace creation through the shared methods is V1-only.
 *   V2 workspace list/remove remain no-ops for cleanup of stored workspace IDs.
 */
export function createV2Client(ctx: V2Context, deps: V2ClientDeps = {}): PluginClient {
  // 2.0.19+ worktree endpoints require the project; older hosts ignore it.
  const project = (): Record<string, unknown> => {
    const projectID = ctx.location?.project?.id
    return projectID ? { projectID } : {}
  }
  function toV2Permissions(permissions?: PermissionRule[]) {
    // V1 action names predate the V2 vocabulary: bash is now shell.
    return permissions?.map((rule) => ({
      action: rule.permission === "bash" ? "shell" : rule.permission,
      resource: rule.pattern,
      effect: rule.action,
    }))
  }

  async function applyLegacyPermissions(id: string, permissions: ReturnType<typeof toV2Permissions>) {
    // Before 2.0.19, session rules had to be re-asserted after create.
    if (permissions && typeof ctx.permission?.rules === "function") {
      await ctx.permission.rules({ sessionID: id, permissions })
    }
  }

  return {
    createIsolatedSession: async ({ parentID, name, title, permissions, signal }) => {
      const lead = await ctx.session.get({ sessionID: parentID }) as SessionInfo | undefined
      if (!lead?.location?.directory) throw new Error(`Lead session "${parentID}" has no worktree location`)
      const from = await realpath(lead.location.directory)
      const head = await git(from, "rev-parse", "--verify", "HEAD^{commit}")
      const existingWorktrees = await gitWorktrees(from)
      const existingRefs = (await git(from, "for-each-ref", "--format=%(refname)", "refs/heads")).split("\n")
      const worktreeProject = lead.projectID ? { projectID: lead.projectID } : project()
      let directory: string | undefined
      let branch: string | undefined
      let checkout: string | undefined
      let sessionID: string | undefined
      let unverifiedWorktree: string | undefined
      let creatingSession = false
      try {
        signal.throwIfAborted()
        // Pin the commit, not the source path: a Git-created lead checkout
        // need not appear in the host's worktree inventory.
        const created = await ctx.worktree.create({ ...worktreeProject, name, branch: head })
        unverifiedWorktree = created.directory
        const resolved = await realpath(created.directory)
        if (existingWorktrees.includes(resolved) || !(await gitWorktrees(from)).includes(resolved)) {
          throw new Error(`OpenCode returned "${resolved}", which is not a new worktree of the lead's repository`)
        }
        directory = resolved
        unverifiedWorktree = undefined
        checkout = await git(directory, "rev-parse", "--verify", "HEAD")
        if (checkout !== head) {
          throw new Error(`Worktree "${directory}" started at ${checkout}, expected lead commit ${head}`)
        }
        const hostBranch = await git(directory, "branch", "--show-current")
        if (hostBranch) {
          if (existingRefs.includes(`refs/heads/${hostBranch}`)) {
            throw new Error(`Worktree "${directory}" checked out an existing branch "${hostBranch}"`)
          }
          branch = hostBranch
        }
        signal.throwIfAborted()
        if (!branch) {
          await git(directory, "switch", "-c", name)
          branch = name
        }
        signal.throwIfAborted()

        const rules = toV2Permissions(permissions(directory))
        creatingSession = true
        const child = await ctx.session.create({ parentID, title, permissions: rules, location: { directory } })
        sessionID = child.id
        if (!sessionID) throw new Error("OpenCode returned no child session ID")
        signal.throwIfAborted()
        if (!await sessionIsIn(child, directory)) {
          // A linked child can inherit the parent's location on create.
          if (!ctx.session.move || !ctx.session.wait) {
            throw new Error(`Cannot bind child session "${sessionID}" to "${directory}": session move is unavailable`)
          }
          signal.throwIfAborted()
          await ctx.session.move({ sessionID, directory, delivery: "queue" })
          await ctx.session.wait({ sessionID })
          const moved = await ctx.session.get({ sessionID }) as SessionInfo | undefined
          if (!await sessionIsIn(moved, directory)) {
            throw new Error(`Child session "${sessionID}" did not move to worktree directory "${directory}"`)
          }
        }
        signal.throwIfAborted()
        await applyLegacyPermissions(sessionID, rules)
        checkout = await git(directory, "rev-parse", "--verify", "HEAD")
        if (checkout !== head) {
          throw new Error(`Worktree "${directory}" is at ${checkout}, expected lead commit ${head}`)
        }
        const ref = await git(directory, "symbolic-ref", "HEAD")
        if (ref !== `refs/heads/${branch}`) {
          throw new Error(`Worktree "${directory}" is on "${ref}", expected branch "${branch}"`)
        }
        signal.throwIfAborted()
        return { sessionID, directory, branch }
      } catch (error) {
        const residuals: string[] = []
        if (unverifiedWorktree) residuals.push(`unverified worktree "${unverifiedWorktree}" was left untouched`)
        let childRemoved = !creatingSession
        if (sessionID) {
          try {
            if (!ctx.session.remove) throw new Error("session.remove is unavailable on this host")
            await ctx.session.remove({ sessionID })
            childRemoved = true
          } catch (err) {
            residuals.push(`could not remove child session "${sessionID}": ${err}`)
          }
        } else if (creatingSession) {
          residuals.push("session.create returned no session ID for cleanup")
        }
        if (directory && !childRemoved) {
          residuals.push(`worktree "${directory}" was kept for the remaining child session`)
        }
        if (directory && childRemoved) {
          try {
            if ((await gitWorktrees(from)).includes(directory)) {
              // A clean detached checkout can still contain the only ref to a
              // commit. Recheck after session cleanup and before host removal.
              const currentHead = await git(directory, "rev-parse", "--verify", "HEAD")
              const observedHead = currentHead === head ? checkout : currentHead
              if (observedHead && observedHead !== head) {
                throw new Error(`observed HEAD at ${observedHead}, expected lead commit ${head}`)
              }
              await ctx.worktree.remove({ ...worktreeProject, directory, force: false })
            }
            if (branch) {
              const tip = await git(from, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)
              if (tip && tip !== head) throw new Error(`branch "${branch}" points at ${tip}, expected ${head}`)
              if (tip) await git(from, "branch", "-d", "--", branch)
            }
          } catch (err) {
            residuals.push(`could not finish cleanup of worktree "${directory}": ${err}`)
          }
        }
        const message = [String(error), ...residuals].join(". ")
        if (signal.aborted || residuals.length) vlog(`Isolated spawn "${name}" failed: ${message}`)
        throw new Error(message)
      }
    },
    agent: {
      readOnly: async (agent: string) => {
        if (!ctx.agent) return undefined
        try {
          const info = (await ctx.agent.get({ agentID: agent })) as { permissions?: unknown; data?: { permissions?: unknown } } | undefined
          return agentRulesAreReadOnly(info?.permissions ?? info?.data?.permissions)
        } catch {
          return undefined
        }
      },
    },
    session: {
      create: async (options) => {
        const input: Record<string, unknown> = { title: options.title }
        if (options.parentID) input["parentID"] = options.parentID
        const permissions = toV2Permissions(options.permission)
        if (permissions) input["permissions"] = permissions
        if (options.workspaceID ?? options.directory) {
          input["location"] = {
            ...(options.directory ? { directory: options.directory } : {}),
            ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}),
          }
        }
        const created = await ctx.session.create(input)
        await applyLegacyPermissions(created.id, permissions)
        return { data: { id: created.id } }
      },
      promptAsync: async (options) => {
        // Synthetic (system) messages render as persistent transcript entries
        // instead of fake user turns — the native form for agent notifications.
        if (options.synthetic) {
          return ctx.session.synthetic({ sessionID: options.sessionID, text: joinParts(options.parts), delivery: "queue" })
        }
        if (options.agent) {
          await ctx.session.switchAgent({ sessionID: options.sessionID, agent: options.agent })
        }
        // V2 binds model at create/admission; the shared create signature has
        // no model slot, so apply it here (spawn is the only model passer).
        // Caught live: without this, teammates inherit the server default.
        if (options.model) {
          await ctx.session.switchModel({
            sessionID: options.sessionID,
            model: {
              providerID: options.model.providerID,
              id: options.model.modelID,
              ...(options.model.variant ? { variant: options.model.variant } : {}),
            },
          })
        }
        const text = joinParts(options.parts)
        return ctx.session.prompt({ sessionID: options.sessionID, text, delivery: "queue" })
      },
      abort: async (options) => ctx.session.interrupt({ sessionID: options.sessionID }),
      status: async () => {
        const active = await ctx.session.active()
        const data: Record<string, { type: string }> = {}
        for (const sessionID of Object.keys(active)) data[sessionID] = { type: "busy" }
        return { data }
      },
      messages: async (options) => {
        const messages = await ctx.session.context({ sessionID: options.sessionID })
        return { data: messages as Array<{ info: unknown; parts: unknown[] }> }
      },
      get: async (options) => {
        const data = await ctx.session.get({ sessionID: options.sessionID })
        return { data }
      },
    },
    tui: {
      showToast: async () => undefined,
      selectSession: async (options) => {
        // Native agent switching on V2: shared team_view calls this, the
        // companion receives the event and navigates the TUI to the
        // teammate session. No server-side TUI API exists on V2.
        if (deps.rpcEmitter) {
          await deps.rpcEmitter.events.emit("view", { sessionID: options.sessionID }).catch(() => {
            // Companion optional — never fail team_view for it.
          })
        }
        return undefined
      },
    },
    worktree: {
      create: async () => { throw new Error("V2 worktrees must be created with an isolated session") },
      remove: async (options) => {
        const directory = (options.worktreeRemoveInput as { directory: string }).directory
        return ctx.worktree.remove({ ...project(), directory, force: false })
      },
      list: async () => {
        const entries = await ctx.worktree.list(project())
        return {
          data: entries.map((entry) => ({
            name: entry.directory.split("/").pop() ?? entry.directory,
            branch: "",
            directory: entry.directory,
          })),
        }
      },
      reset: async () => ctx.worktree.refresh(project()),
    },
    workspace: {
      create: async () => { throw new Error("V2 does not create workspaces for isolated sessions") },
      remove: async () => undefined,
      list: async () => ({ data: [] }),
    },
  }
}
