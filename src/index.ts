import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { createDb, getDbPath } from "./db"
import { wrapThrowingClient } from "./client"
import { recoverStaleMembers, recoverUndeliveredMessages, recoverOrphanedWorktrees } from "./recovery"
import { MemberRegistry, DescendantTracker } from "./state"
import { isWorktreeInstance } from "./util"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation, shouldNudgeIdleMember } from "./hooks"
import { notifyTeamEvent, notifyWorkingProgress } from "./notify"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { log, initLog } from "./log"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { ProgressTracker } from "./progress"
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
import type { ToolDeps, } from "./types"
import { TokenBucket } from "./rate-limit"
import { Watchdog } from "./watchdog"

const DEFAULT_RATE_LIMIT_REFILL = 2
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 1000
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

  // Load plugin configuration (global → project → env vars)
  const config = loadConfig(input.directory)

  // Initialize in-memory state
  const registry = new MemberRegistry()
  const tracker = new DescendantTracker()
  const nudgedMembers = new Set<string>()
  const progressTracker = new ProgressTracker()

  // Extract the working HeyAPI transport from the plugin-provided v1 client and pass it
  // to the v2 OpencodeClient. The plugin framework provides a v1 client which stores its
  // HeyAPI transport as `_client` (underscore). The v2 constructor accepts it as `client`.
  type V2Transport = ConstructorParameters<typeof OpencodeClient>[0] extends { client?: infer C } ? C : never
  const pluginTransport = (input.client as unknown as { _client: V2Transport })._client
  const rawClient = new OpencodeClient({ client: pluginTransport })
  initLog(rawClient)
  const client = wrapThrowingClient(rawClient)
  const deps: ToolDeps = { db, registry, tracker, client, directory: input.directory }

  // Recovery only runs for the main project instance — NOT for teammate worktree instances.
  // Worktree instances are created during session.create. Running recovery there makes HTTP
  // calls back to the server, which deadlocks because the server is still handling session.create.
  if (!isWorktreeInstance(input.directory)) {
    log("init:recovery:start (main instance)")
    const recovery = await recoverStaleMembers(db, client)
    if (recovery.interrupted > 0) {
      log(`init:recovery:interrupted=${recovery.interrupted}`)
      const members = db.query(
        "SELECT tm.team_id, tm.name, tm.session_id FROM team_member tm JOIN team t ON tm.team_id = t.id WHERE t.status = 'active'"
      ).all() as Array<{ team_id: string; name: string; session_id: string }>
      for (const m of members) {
        registry.register(m.team_id, m.name, m.session_id)
      }
    }

    recoverUndeliveredMessages(db, client, registry).catch((err) => {
      log(`init:recover-messages:failed err=${err instanceof Error ? err.message : String(err)}`)
    })
    recoverOrphanedWorktrees(db, client).catch((err) => {
      log(`init:recover-worktrees:failed err=${err instanceof Error ? err.message : String(err)}`)
    })
    log("init:recovery:done")
  } else {
    log(`init:skip-recovery (worktree instance: ${input.directory})`)
  }

  // Initialize rate limiter — config value already accounts for env var override
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: DEFAULT_RATE_LIMIT_REFILL,
    refillIntervalMs: DEFAULT_RATE_LIMIT_INTERVAL_MS,
  })

  // Initialize watchdog — config value already accounts for env var override
  const watchdog = new Watchdog({
    db, client, registry,
    ttlMs: config.timeoutMs,
    checkIntervalMs: DEFAULT_WATCHDOG_CHECK_MS,
    progressTracker,
    stallThresholdMs: config.stallThresholdMs,
    stallMinSteps: config.stallMinSteps,
    stallTokenThreshold: config.stallTokenThreshold,
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
            // Nudge teammate if they went idle without reporting to the lead (once only)
            const nudgeKey = `${transition.teamId}:${transition.memberName}`
            if (!nudgedMembers.has(nudgeKey) && shouldNudgeIdleMember(db, transition.teamId, transition.memberName)) {
              nudgedMembers.add(nudgeKey)
              log(`nudge:idle-without-report name=${transition.memberName}`)
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now." }],
              }).catch(() => { /* best effort */ })
            }
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

        // Wake the lead when it goes idle and has pending messages.
        // The system prompt transform delivers the actual message content.
        if (statusType === "idle") {
          const team = db.query("SELECT id FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionID) as { id: string } | null
          if (team) {
            const pending = db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0").get(team.id) as { c: number }
            if (pending.c > 0) {
              log(`wake-lead: ${pending.c} pending messages, sending promptAsync`)
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: `[System: ${pending.c} new team message(s) available]` }],
              }).catch((err) => {
                log(`wake-lead:failed err=${err instanceof Error ? err.message : String(err)}`)
              })
            }
          }
        }
      }

      if (event.type === "session.created") {
        const info = event.properties.info
        if (info.parentID) {
          handleSessionCreatedEvent(tracker, info.id, info.parentID)
        }
      }

      // Track per-step output tokens for stall detection
      if (event.type === "message.part.updated") {
        const part = (event.properties as { part?: { type?: string; sessionID?: string; tokens?: { output?: number } } }).part
        if (part?.type === "step-finish" && part.sessionID && part.tokens?.output !== undefined) {
          if (registry.getBySession(part.sessionID)) {
            progressTracker.recordStep(part.sessionID, part.tokens.output)
          }
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
      log(`system-prompt:transform role=${teamInfo.role} session=${input.sessionID}`)
      const prompt = teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown")
      log(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
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
        const member = db.query("SELECT worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, teamInfo.memberName) as { worktree_branch: string | null; worktree_dir: string | null } | null
        if (member?.worktree_branch) {
          output.env.ENSEMBLE_BRANCH = member.worktree_branch
        }
        if (member?.worktree_dir) {
          output.env.ENSEMBLE_WORKTREE_DIR = member.worktree_dir
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
          // Track message activity for stall detection
          progressTracker.recordMessage(ctx.sessionID)
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
          // Track broadcast activity for stall detection
          progressTracker.recordMessage(ctx.sessionID)
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
          // Track task completion for stall detection
          progressTracker.recordTaskComplete(ctx.sessionID)
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
          // Clean up progress tracking for the shut-down member
          const member = deps.db.query("SELECT session_id FROM team_member WHERE name = ? AND status IN ('shutdown', 'shutdown_requested')").get(args.member) as { session_id: string } | null
          if (member) progressTracker.remove(member.session_id)
          const hasWarning = result.includes("uncommitted")
          ctx.metadata({ title: hasWarning ? `${args.member} shut down — uncommitted changes` : `${args.member} shut down` })
          return result
        },
      }),

      team_cleanup: tool({
        description: "Clean up the team. All teammates must be shut down first. Removes team data and frees resources.",
        args: {
          force: tool.schema.boolean().default(false).describe("Force cleanup even if members are active (will abort them)"),
          acknowledge_uncommitted: tool.schema.boolean().default(false),
        },
        async execute(args, ctx) {
          const result = await executeTeamCleanup(deps, args, ctx.sessionID, undefined, undefined, config.mergeOnCleanup)
          const blocked = result.includes("uncommitted")
          ctx.metadata({ title: blocked ? "Cleanup blocked — uncommitted changes" : "Team cleaned up" })
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
