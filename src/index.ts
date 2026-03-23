import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { OpencodeClient as OpencodeClientV2 } from "@opencode-ai/sdk/v2"
import path from "path"
import { mkdirSync } from "node:fs"
import { createDb, getDbPath } from "./db"
import { wrapThrowingClient } from "./client"
import { recoverStaleMembers, recoverUndeliveredMessages, recoverOrphanedWorktrees } from "./recovery"
import { MemberRegistry, DescendantTracker } from "./state"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation } from "./hooks"
import { notifyTeamEvent, notifyWorkingProgress } from "./notify"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { findTeamBySession } from "./types"
import { executeTeamCreate } from "./tools/team-create"
import { executeTeamSpawn } from "./tools/team-spawn"
import { executeTeamMessage } from "./tools/team-message"
import { executeTeamBroadcast } from "./tools/team-broadcast"
import { executeTeamShutdown } from "./tools/team-shutdown"
import { executeTeamCleanup } from "./tools/team-cleanup"
import { executeTeamTasksList } from "./tools/team-tasks-list"
import { executeTeamTasksAdd } from "./tools/team-tasks-add"
import { executeTeamTasksComplete } from "./tools/team-tasks-complete"
import { executeTeamClaim } from "./tools/team-claim"
import { executeTeamResults } from "./tools/team-results"
import { executeTeamStatus } from "./tools/team-status"
import { executeTeamView } from "./tools/team-view"
import type { ToolDeps, PluginClient } from "./types"
import { TokenBucket } from "./rate-limit"
import { Watchdog } from "./watchdog"

const DEFAULT_RATE_LIMIT_CAPACITY = 10
const DEFAULT_RATE_LIMIT_REFILL = 2
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 1000
const DEFAULT_WATCHDOG_TTL_MS = 30 * 60 * 1000 // 30 minutes
const DEFAULT_WATCHDOG_CHECK_MS = 60 * 1000 // 60 seconds

/**
 * opencode-ensemble plugin entry point.
 * Enables agent teams: multiple agents running in parallel with
 * peer-to-peer communication, shared task management, and coordinated execution.
 */
const plugin: Plugin = async (input) => {
  // Initialize SQLite database in the global OpenCode config directory
  const dbPath = getDbPath()
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = createDb(dbPath)

  // Initialize in-memory state
  const registry = new MemberRegistry()
  const tracker = new DescendantTracker()

  // Reuse the v1 client's working HTTP transport with v2's method signatures.
  // The v1 client (input.client) has the correct connection (Unix socket/auth),
  // while v2 gives us flat params + permission on create + agent/tools on promptAsync.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawClient = new OpencodeClientV2({ client: (input.client as any)._client })
  const client = wrapThrowingClient(rawClient)
  const deps: ToolDeps = { db, registry, tracker, client, directory: input.directory }

  // Run recovery on init — mark stale busy members as error + abort orphaned sessions
  const recovery = await recoverStaleMembers(db, client)
  if (recovery.interrupted > 0) {
    // Rebuild registry from DB for recovered members
    const members = db.query(
      "SELECT tm.team_id, tm.name, tm.session_id FROM team_member tm JOIN team t ON tm.team_id = t.id WHERE t.status = 'active'"
    ).all() as Array<{ team_id: string; name: string; session_id: string }>
    for (const m of members) {
      registry.register(m.team_id, m.name, m.session_id)
    }
  }

  // Redeliver undelivered messages from previous sessions
  recoverUndeliveredMessages(db, client, registry).catch(() => {
    // Best effort — don't block plugin init
  })

  // Clean up orphaned worktrees from crashed teams
  recoverOrphanedWorktrees(db, client).catch(() => {
    // Best effort — don't block plugin init
  })

  // Initialize rate limiter
  // OPENCODE_ENSEMBLE_RATE_LIMIT=0 disables it entirely
  const rateLimitEnv = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  const rateLimitCapacity = rateLimitEnv === "0" ? 0 : (parseInt(rateLimitEnv ?? "", 10) || DEFAULT_RATE_LIMIT_CAPACITY)
  const rateLimiter = new TokenBucket({
    capacity: rateLimitCapacity,
    refillRate: DEFAULT_RATE_LIMIT_REFILL,
    refillIntervalMs: DEFAULT_RATE_LIMIT_INTERVAL_MS,
  })

  // Initialize watchdog for teammate timeouts
  // OPENCODE_ENSEMBLE_TIMEOUT=0 disables it entirely
  const timeoutEnv = process.env.OPENCODE_ENSEMBLE_TIMEOUT
  const watchdogTtl = timeoutEnv === "0" ? 0 : (parseInt(timeoutEnv ?? "", 10) || DEFAULT_WATCHDOG_TTL_MS)
  const watchdog = new Watchdog({
    db, client, registry,
    ttlMs: watchdogTtl,
    checkIntervalMs: DEFAULT_WATCHDOG_CHECK_MS,
  })
  watchdog.start()

  return {
    // Event hook — drives state machine transitions + descendant tracking + toasts
    async event({ event }) {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        const statusType = status.type as "idle" | "busy" | "retry"
        const transition = handleSessionStatusEvent(db, registry, sessionID, statusType)

        // Fire toast notifications for meaningful transitions
        if (transition) {
          if (transition.to === "shutdown") {
            notifyTeamEvent(client, "shutdown", { memberName: transition.memberName })
          } else if (transition.to === "ready" && transition.from === "busy") {
            notifyTeamEvent(client, "completed", { memberName: transition.memberName })
          } else if (transition.to === "error") {
            notifyTeamEvent(client, "error", { memberName: transition.memberName })
          } else if (transition.to === "retry") {
            // Teammate is being rate-limited — notify user
            try {
              await client.tui.showToast({
                title: "Team",
                message: `${transition.memberName} is being rate-limited`,
                variant: "warning",
                duration: 3000,
              })
            } catch { /* TUI may not be available */ }
          } else if (transition.to === "busy_while_shutdown") {
            // Session went busy after shutdown was requested — re-issue abort
            const entry = registry.getBySession(sessionID)
            if (entry) {
              try {
                await client.session.abort({ sessionID })
              } catch { /* best effort */ }
            }
          }

          // Show working progress after every transition so the user sees who's still active
          await notifyWorkingProgress(client, db, transition.teamId)
        }
      }

      if (event.type === "session.created") {
        const info = event.properties.info
        if (info.parentID) {
          handleSessionCreatedEvent(tracker, info.id, info.parentID)
        }
      }
    },

    // Sub-agent isolation + rate limiting hook
    "tool.execute.before": async (input, _output) => {
      checkToolIsolation(registry, tracker, input.tool, input.sessionID)
      // Rate limit team tools that trigger LLM inference
      if (input.tool.startsWith("team_")) {
        if (!rateLimiter.tryConsume()) {
          await rateLimiter.waitForToken()
        }
      }
    },

    // System prompt injection — keeps lead aware of team state, reminds teammates of role
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      const prompt = teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName!)
      output.system.push(prompt)
    },

    // Compaction safety — preserves team context when sessions get long
    "experimental.session.compacting": async (input, output) => {
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName)
      output.context.push(context)
    },

    // Team-aware shell environment for scripts and hooks
    "shell.env": async (input, output) => {
      if (!input.sessionID) return
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      output.env.ENSEMBLE_TEAM = teamInfo.teamName
      output.env.ENSEMBLE_ROLE = teamInfo.role
      if (teamInfo.memberName) {
        output.env.ENSEMBLE_MEMBER = teamInfo.memberName
        const member = db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, teamInfo.memberName) as { worktree_branch: string | null } | null
        if (member?.worktree_branch) {
          output.env.ENSEMBLE_BRANCH = member.worktree_branch
        }
      }
    },

    // Register all team tools
    tool: {
      team_create: tool({
        description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
        args: {
          name: tool.schema.string().describe("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamCreate(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Created team: ${args.name}` })
          return result
        },
      }),

      team_spawn: tool({
        description: "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt. " +
          "Each teammate gets their own git worktree for file isolation. " +
          "Teammates work asynchronously and will message you when done. Do not poll for their status.",
        args: {
          name: tool.schema.string().describe("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: tool.schema.string().default("build").describe("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: tool.schema.string().describe("Task instructions for the teammate"),
          model: tool.schema.string().optional().describe("Model in provider/model format (optional, uses default)"),
          claim_task: tool.schema.string().optional().describe("Task ID to auto-claim for this teammate (optional)"),
          worktree: tool.schema.boolean().default(true).describe("Create a git worktree for file isolation (default: true, set false for read-only agents)"),
          plan_approval: tool.schema.boolean().default(false).describe("Require teammate to send a plan for approval before writing files (default: false)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamSpawn(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Spawned ${args.name} (${args.agent})` })
          return result
        },
      }),

      team_message: tool({
        description: "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead.",
        args: {
          to: tool.schema.string().describe("Recipient name ('lead' or teammate name)"),
          text: tool.schema.string().describe("Message content (max 10KB)"),
          approve: tool.schema.boolean().optional().describe("Approve a teammate's plan (only when recipient has plan_approval='pending')"),
          reject: tool.schema.string().optional().describe("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
        },
        async execute(args, ctx) {
          const result = await executeTeamMessage(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Message → ${args.to}` })
          return result
        },
      }),

      team_broadcast: tool({
        description: "Send a message to all teammates and the lead (excluding yourself).",
        args: {
          text: tool.schema.string().describe("Message content (max 10KB)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamBroadcast(deps, args, ctx.sessionID)
          ctx.metadata({ title: "Broadcast to team" })
          return result
        },
      }),

      team_tasks_list: tool({
        description: "View the shared team task board. Use this to check task status, not to wait for teammates. Teammates will message you when done.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamTasksList(deps, ctx.sessionID)
          const count = result === "No tasks on the board." ? 0 : result.split("\n").length
          ctx.metadata({ title: count > 0 ? `Task board (${count} tasks)` : "Task board (empty)" })
          return result
        },
      }),

      team_tasks_add: tool({
        description: "Add tasks to the shared team task board so teammates can see what work is available and claim it.",
        args: {
          tasks: tool.schema.array(tool.schema.object({
            content: tool.schema.string().describe("Task description"),
            priority: tool.schema.enum(["high", "medium", "low"]).default("medium").describe("Task priority"),
            depends_on: tool.schema.array(tool.schema.string()).optional().describe("Task IDs this depends on"),
          })).describe("Tasks to add"),
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksAdd(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Added ${args.tasks.length} task${args.tasks.length !== 1 ? "s" : ""}` })
          return result
        },
      }),

      team_tasks_complete: tool({
        description: "Mark a task as completed on the shared board. This unblocks any tasks that depend on it.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to mark complete"),
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksComplete(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Completed task` })
          return result
        },
      }),

      team_claim: tool({
        description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to claim"),
        },
        async execute(args, ctx) {
          const result = await executeTeamClaim(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Claimed task` })
          return result
        },
      }),

      team_results: tool({
        description: "Retrieve full message content from teammates. Returns unread messages and marks them as read. Use this after receiving a truncated message notification.",
        args: {
          from: tool.schema.string().optional().describe("Filter messages by sender name (optional, returns all if omitted)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamResults(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Results${args.from ? ` from ${args.from}` : ""}` })
          return result
        },
      }),

      team_shutdown: tool({
        description: "Request a teammate to shut down. The teammate finishes current work then stops. " +
          "Pass force: true to abort immediately without waiting.",
        args: {
          member: tool.schema.string().describe("Teammate name to shut down"),
          force: tool.schema.boolean().default(false).describe("Force immediate abort without waiting for current work to finish"),
        },
        async execute(args, ctx) {
          const result = await executeTeamShutdown(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Shutdown → ${args.member}` })
          return result
        },
      }),

      team_cleanup: tool({
        description: "Clean up the team. All teammates must be shut down first. Removes team data and frees resources.",
        args: {
          force: tool.schema.boolean().default(false).describe("Force cleanup even if members are active (will abort them)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamCleanup(deps, args, ctx.sessionID)
          ctx.metadata({ title: "Team cleaned up" })
          return result
        },
      }),

      team_status: tool({
        description: "View team members with their current status, agent type, and session IDs. " +
          "Use this to check who is working, idle, or shut down. Includes a task summary.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamStatus(deps, ctx.sessionID)
          const statusMap: Record<string, string> = { busy: "working", ready: "idle", shutdown_requested: "stopping", shutdown: "done", error: "error" }
          const members = deps.db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE lead_session_id = ? OR id IN (SELECT team_id FROM team_member WHERE session_id = ?))").all(ctx.sessionID, ctx.sessionID) as Array<{ name: string; status: string }>
          const summary = members.map(m => `${m.name}: ${statusMap[m.status] ?? m.status}`).join(", ")
          ctx.metadata({ title: summary || "No teammates" })
          return result
        },
      }),

      team_view: tool({
        description: "Navigate the TUI to a teammate's session so you can see what they are doing. " +
          "Use the session picker (ctrl+p) to return to the lead session.",
        args: {
          member: tool.schema.string().describe("Teammate name to view"),
        },
        async execute(args, ctx) {
          const result = await executeTeamView(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Viewing ${args.member}` })
          return result
        },
      }),
    },
  }
}

export default plugin
