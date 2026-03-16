import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import path from "path"
import { createDb } from "./db"
import { recoverStaleMembers } from "./recovery"
import { MemberRegistry, DescendantTracker } from "./state"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation } from "./hooks"
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
import { executeTeamApprovePlan } from "./tools/team-approve-plan"
import type { ToolDeps, PluginClient } from "./types"
import { TokenBucket } from "./rate-limit"

const DEFAULT_RATE_LIMIT_CAPACITY = 10
const DEFAULT_RATE_LIMIT_REFILL = 2
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 1000

/**
 * opencode-ensemble plugin entry point.
 * Enables agent teams: multiple agents running in parallel with
 * peer-to-peer communication, shared task management, and coordinated execution.
 */
const plugin: Plugin = async (input) => {
  // Initialize SQLite database in the project's .opencode directory
  const dbPath = path.join(input.directory, ".opencode", "ensemble.db")
  const db = createDb(dbPath)

  // Initialize in-memory state
  const registry = new MemberRegistry()
  const tracker = new DescendantTracker()

  // Run recovery on init — mark stale busy members as error
  const recovery = recoverStaleMembers(db)
  if (recovery.interrupted > 0) {
    // Rebuild registry from DB for recovered members
    const members = db.query(
      "SELECT tm.team_id, tm.name, tm.session_id FROM team_member tm JOIN team t ON tm.team_id = t.id WHERE t.status = 'active'"
    ).all() as Array<{ team_id: string; name: string; session_id: string }>
    for (const m of members) {
      registry.register(m.team_id, m.name, m.session_id)
    }
  }

  // Build shared tool dependencies
  const client = input.client as unknown as PluginClient
  const deps: ToolDeps = { db, registry, tracker, client }

  // Initialize rate limiter
  // OPENCODE_ENSEMBLE_RATE_LIMIT=0 disables it entirely
  const rateLimitEnv = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  const rateLimitCapacity = rateLimitEnv === "0" ? 0 : (parseInt(rateLimitEnv ?? "", 10) || DEFAULT_RATE_LIMIT_CAPACITY)
  const rateLimiter = new TokenBucket({
    capacity: rateLimitCapacity,
    refillRate: DEFAULT_RATE_LIMIT_REFILL,
    refillIntervalMs: DEFAULT_RATE_LIMIT_INTERVAL_MS,
  })

  return {
    // Event hook — drives state machine transitions + descendant tracking
    async event({ event }) {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        const statusType = status.type as "idle" | "busy" | "retry"
        handleSessionStatusEvent(db, registry, sessionID, statusType)
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

    // Register all 11 team tools
    tool: {
      team_create: tool({
        description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
        args: {
          name: tool.schema.string().describe("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
        },
        async execute(args, ctx) {
          return executeTeamCreate(deps, args, ctx.sessionID)
        },
      }),

      team_spawn: tool({
        description: "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt.",
        args: {
          name: tool.schema.string().describe("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: tool.schema.string().default("build").describe("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: tool.schema.string().describe("Task instructions for the teammate"),
          model: tool.schema.string().optional().describe("Model in provider/model format (optional, uses default)"),
          claim_task: tool.schema.string().optional().describe("Task ID to auto-claim for this teammate (optional)"),
        },
        async execute(args, ctx) {
          return executeTeamSpawn(deps, args, ctx.sessionID)
        },
      }),

      team_message: tool({
        description: "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead.",
        args: {
          to: tool.schema.string().describe("Recipient name ('lead' or teammate name)"),
          text: tool.schema.string().describe("Message content (max 10KB)"),
        },
        async execute(args, ctx) {
          return executeTeamMessage(deps, args, ctx.sessionID)
        },
      }),

      team_broadcast: tool({
        description: "Send a message to all teammates and the lead (excluding yourself).",
        args: {
          text: tool.schema.string().describe("Message content (max 10KB)"),
        },
        async execute(args, ctx) {
          return executeTeamBroadcast(deps, args, ctx.sessionID)
        },
      }),

      team_tasks_list: tool({
        description: "View the shared team task board. Shows all tasks with status, assignee, and dependencies so teammates can coordinate work.",
        args: {},
        async execute(_args, ctx) {
          return executeTeamTasksList(deps, ctx.sessionID)
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
          return executeTeamTasksAdd(deps, args, ctx.sessionID)
        },
      }),

      team_tasks_complete: tool({
        description: "Mark a task as completed on the shared board. This unblocks any tasks that depend on it.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to mark complete"),
        },
        async execute(args, ctx) {
          return executeTeamTasksComplete(deps, args, ctx.sessionID)
        },
      }),

      team_claim: tool({
        description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to claim"),
        },
        async execute(args, ctx) {
          return executeTeamClaim(deps, args, ctx.sessionID)
        },
      }),

      team_approve_plan: tool({
        description: "Approve or reject a teammate's implementation plan. Only the team lead can use this.",
        args: {
          member: tool.schema.string().describe("Teammate name"),
          approved: tool.schema.boolean().describe("true to approve, false to reject"),
          feedback: tool.schema.string().optional().describe("Feedback message (optional)"),
        },
        async execute(args, ctx) {
          return executeTeamApprovePlan(deps, args, ctx.sessionID)
        },
      }),

      team_shutdown: tool({
        description: "Request a teammate to shut down. The teammate finishes current work then stops.",
        args: {
          member: tool.schema.string().describe("Teammate name to shut down"),
        },
        async execute(args, ctx) {
          return executeTeamShutdown(deps, args, ctx.sessionID)
        },
      }),

      team_cleanup: tool({
        description: "Clean up the team. All teammates must be shut down first. Removes team data and frees resources.",
        args: {
          force: tool.schema.boolean().default(false).describe("Force cleanup even if members are active (will abort them)"),
        },
        async execute(args, ctx) {
          return executeTeamCleanup(deps, args, ctx.sessionID)
        },
      }),
    },
  }
}

export default plugin
