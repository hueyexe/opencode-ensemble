import type { PluginClient } from "./types"
import { log } from "./log"
import { runCommand } from "./process"

/** V2 plugin context subset Ensemble needs (structural, mock-friendly). */
export interface V2Context {
  /** Plugin location; `project.id` is required by the 2.0.19+ worktree API. */
  location?: { directory?: string; project?: { id?: string } }
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
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

/** Prefix marking a workspace id that is really a local directory (see below). */
const DIR_WORKSPACE_PREFIX = "v2dir:"

/** Injectable shell lookups (default to git; overridden in tests). */
export interface V2ClientDeps {
  /** Current branch checked out in a directory, or null when unknown. */
  gitBranch?: (directory: string) => Promise<string | null>
  /** Create and check out a branch in a directory. Returns the effective
   * branch name, or null when the branch could not be created or checked
   * out — never record the requested name without this confirmation. */
  gitCreateBranch?: (directory: string, branch: string) => Promise<string | null>
  /** Worktree directory currently on a branch, or null when none. */
  gitDir?: (branch: string) => Promise<string | null>
  /** RPC emitter for companion events (team_view navigation). */
  rpcEmitter?: { events: { emit(name: string, data: unknown): Promise<unknown> } }
}

/** Current branch in a directory via git. */
async function gitBranchDefault(directory: string): Promise<string | null> {
  try {
    const result = await runCommand(["git", "branch", "--show-current"], { cwd: directory })
    const branch = result.stdout.trim()
    return result.exitCode === 0 && branch ? branch : null
  } catch {
    return null
  }
}

/** Create and check out a branch in a directory via git. Returns the
 * effective branch name, or null when neither create nor switch worked —
 * callers must record the return value, not the requested name, so a
 * failed create can never be recorded as a live branch. */
async function gitCreateBranchDefault(directory: string, branch: string): Promise<string | null> {
  try {
    await runCommand(["git", "switch", "-c", branch], { cwd: directory })
    return branch
  } catch (err) {
    // The branch may already exist (re-spawn after the abort-cleanup race
    // documented in AGENTS.md) — switch to it instead of recording a name
    // with no ref behind it. Log both attempts; swallowing failures silently
    // made team_merge squash a stale branch and silently lose new work
    // (PR #46 review).
    log(`v2-client:gitCreateBranch:create-failed directory=${directory} branch=${branch} err=${err instanceof Error ? err.message : String(err)} — trying existing branch`)
    try {
      await runCommand(["git", "switch", branch], { cwd: directory })
      return branch
    } catch (err2) {
      log(`v2-client:gitCreateBranch:switch-failed directory=${directory} branch=${branch} err=${err2 instanceof Error ? err2.message : String(err2)}`)
      return null
    }
  }
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
 * team tools run unchanged on V2 (DRY: one adapter, zero logic forks).
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
 * - worktree.create: V2 reports only the directory, so the branch is read
 *   back via git (falls back to the requested name). OQ-V2-branch.
 * - worktree.list: V2 entries carry directory only; name is the basename
 *   (recovery filters on the `ensemble-` prefix — a non-matching dir is
 *   skipped, never wrongly deleted). reset has no production callers and
 *   maps to refresh. OQ-V2-wtname.
 * - workspace.*: V2 ctx has no workspace domain (workspaces are
 *   provider-based). create bridges a branch to its worktree directory and
 *   returns a `v2dir:<dir>` id; session.create routes that id to
 *   location.directory, preserving worktree isolation with zero tool
 *   changes. list returns [] and remove resolves — the DB workspace_id
 *   column stays the source of truth and is still nulled by cleanup.
 */
export function createV2Client(ctx: V2Context, deps: V2ClientDeps = {}): PluginClient {
  const gitBranch = deps.gitBranch ?? gitBranchDefault
  const gitCreateBranch = deps.gitCreateBranch ?? gitCreateBranchDefault
  // 2.0.19+ worktree endpoints require the project; older hosts ignore it.
  const project = (): Record<string, unknown> => {
    const projectID = ctx.location?.project?.id
    return projectID ? { projectID } : {}
  }
  return {
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
        // V1 action names predate the V2 vocabulary: bash is now shell.
        const V1_ACTION_MAP: Record<string, string> = { bash: "shell" }
        const permissions = options.permission?.map((rule) => ({
          action: V1_ACTION_MAP[rule.permission] ?? rule.permission,
          resource: rule.pattern,
          effect: rule.action,
        }))
        if (permissions) input["permissions"] = permissions
        if (options.workspaceID ?? options.directory) {
          if (options.workspaceID?.startsWith(DIR_WORKSPACE_PREFIX)) {
            input["location"] = {
              directory: options.workspaceID.slice(DIR_WORKSPACE_PREFIX.length),
            }
          } else {
            input["location"] = {
              ...(options.directory ? { directory: options.directory } : {}),
              ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}),
            }
          }
        }
        const created = await ctx.session.create(input)
        if (permissions && typeof ctx.permission?.rules === "function") {
          // 2.0.3–2.0.18 merged agent rules after session rules, so create()
          // permissions lost to the agent's and had to be re-asserted. From
          // 2.0.19 the session ruleset merges last (core permission.ts
          // `merge(agent.permissions, session.permissions)` with last-match
          // evaluation) and rules() no longer exists, so create() is enough.
          await ctx.permission.rules({ sessionID: created.id, permissions })
        }
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
            model: { providerID: options.model.providerID, id: options.model.modelID },
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
      create: async (options) => {
        const name = (options.worktreeCreateInput as { name?: string } | undefined)?.name ?? "ensemble-worktree"
        const created = await ctx.worktree.create({ ...project(), name })
        let branch = await gitBranch(created.directory)
        if (!branch) {
          // 2.0.32+ creates worktrees detached; team_merge needs a named
          // branch. Record the effective branch only — never the requested
          // name — so a failed create cannot point team_merge at a stale
          // same-named branch whose commits would silently shadow new work
          // (PR #46 review).
          branch = (await gitCreateBranch(created.directory, name)) ?? ""
        }
        return { data: { name, branch, directory: created.directory } }
      },
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
      create: async (options) => {
        const branch = (options as { branch?: string }).branch ?? ""
        const directory = await deps.gitDir?.(branch)
        if (!directory) throw new Error(`V2 workspace bridge: no worktree found on branch "${branch}"`)
        return {
          data: {
            id: `${DIR_WORKSPACE_PREFIX}${directory}`,
            type: "local",
            branch,
            directory,
            projectID: "",
          },
        }
      },
      remove: async () => undefined,
      list: async () => ({
        data: [] as Array<{
          id: string
          type: string
          branch: string | null
          directory: string | null
          projectID: string
        }>,
      }),
    },
  } as PluginClient
}
