import type { Database } from "./db"
import { createDb, getDbPath } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import { MemberRegistry as MemberRegistryImpl, DescendantTracker as DescendantTrackerImpl, PendingPurgeApprovals } from "./state"
import { dispatchV2Event, type V2EventLike } from "./v2-events"
import { deliverPrompt, type V2SessionPort } from "./v2-session"
import type { V2Context } from "./v2-client"
import { createV2Client } from "./v2-client"
import { registerV2Tools } from "./v2-tools"
import type { ToolDeps } from "./types"
import { ProgressTracker } from "./progress"
import { checkToolIsolation, shouldNudgeIdleMember } from "./hooks"
import { hasReportedCompletion } from "./messaging"
import { enrichToolError } from "./tool-arg-hint"
import { rehydrateRegistry } from "./recovery"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { TokenBucket } from "./rate-limit"
import { ActivityBuffer, recordFromToolBefore, recordFromToolAfter } from "./activity"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { startDashboard, type DashboardServer } from "./dashboard"
import { EnsembleRpc, emitMemberEvent, emitNoticeEvent } from "./v2-rpc"
import { isWorktreeInstance } from "./util"
import { vlog } from "./log"

/** V2 setup context subset (structural, mock-friendly). */
export interface V2SetupContext {
  location: { directory: string; project?: { id?: string } }
  agent?: V2Context["agent"]
  options: Record<string, unknown>
  session: V2Context["session"] & {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
  worktree: V2Context["worktree"]
  permission: V2Context["permission"]
  event: {
    subscribe(opts?: { signal?: AbortSignal }): AsyncIterable<V2EventLike>
  }
  tool: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
    transform(cb: (editor: never) => void): Promise<{ dispose(): Promise<void> }>
  }
  rpc: {
    register(
      definition: unknown,
      handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    ): Promise<{ events: { emit(name: string, data: unknown): Promise<unknown> } }>
  }
  shell: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
}

/** Extract answer text from a V2 tool result for approval matching. */
export function extractQuestionOutput(result?: {
  content?: string | Array<{ type?: string; text?: string }>
}): string {
  const content = result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
  }
  return ""
}

/** Options for setupEnsemble. */
export interface SetupOptions {
  /** SQLite path. Defaults to the global ensemble.db. */
  dbPath?: string
  /** Dashboard port. Defaults to config; 0 disables. */
  dashboardPort?: number
}

/** Live handle for a V2 ensemble instance. */
export interface EnsembleHandle {
  db: Database
  registry: MemberRegistry
  tracker: DescendantTracker
  /** Dispatch one event (used by the live subscription loop; tests call directly). */
  dispatch(event: V2EventLike): Promise<void>
  /** Stop the event loop and release resources. */
  dispose(): Promise<void>
}

/**
 * Initialize Ensemble on a V2 plugin context: database, registries, event
 * subscription, tool hooks, session hooks, and shell env. Tool registration
 * lands in the next slice.
 */
export async function setupEnsemble(
  ctx: V2SetupContext,
  options: SetupOptions = {},
): Promise<EnsembleHandle> {
  const db = createDb(options.dbPath ?? getDbPath())
  const config = loadConfig(ctx.location.directory)
  const registry: MemberRegistry = new MemberRegistryImpl()
  const tracker: DescendantTracker = new DescendantTrackerImpl()
  const purgeApprovals = new PendingPurgeApprovals()
  const activityBuffer = new ActivityBuffer()
  const progressTracker = new ProgressTracker()
  const nudgedMembers = new Set<string>()

  // Rehydrate the in-memory registry from SQLite so members from before a
  // restart are visible again. Without this, their events are ignored and
  // teams freeze silently after every server restart (seen live 2026-09-14).
  const rehydrated = rehydrateRegistry(db, registry)
  if (rehydrated > 0) vlog(`init:registry:rehydrated members=${rehydrated}`)

  /** Send the idle-without-report nudge once per member. */
  const nudgeMember = (teamId: string, memberName: string, sessionId: string): void => {
    const nudgeKey = `${teamId}:${memberName}`
    if (nudgedMembers.has(nudgeKey)) return
    if (!shouldNudgeIdleMember(db, teamId, memberName)) return
    if (hasReportedCompletion(db, teamId, memberName)) return
    nudgedMembers.add(nudgeKey)
    // Persist so hot-reloads don't re-nudge: every setup re-runs the sweep,
    // and without this each file save re-nudged every silent member (seen
    // live 2026-09-14 — 40+ nudges on one scout).
    db.run("UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?", [
      Date.now(),
      teamId,
      memberName,
    ])
    vlog(`nudge:idle-without-report name=${memberName}`)
    void deliverPrompt(
      ctx.session as unknown as V2SessionPort,
      sessionId,
      "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now.",
    ).catch((err) => {
      vlog(`nudge:idle-without-report:failed name=${memberName} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }

  // Startup sweep: members already idle (e.g. finished while the plugin was
  // down) never emit a fresh transition, so nudge them now. Skip members
  // nudged within the hour — the guard survives reloads via the DB column.
  const nudgeCutoff = Date.now() - 60 * 60 * 1000
  const silent = db.query(
    `SELECT tm.team_id, tm.name, tm.session_id FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active' AND tm.status = 'ready'
       AND (tm.last_nudged_at IS NULL OR tm.last_nudged_at < ?)`,
  ).all(nudgeCutoff) as Array<{ team_id: string; name: string; session_id: string }>
  for (const member of silent) nudgeMember(member.team_id, member.name, member.session_id)
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: 2,
    refillIntervalMs: 1000,
  })
  const controller = new AbortController()

  const dispatch = async (event: V2EventLike): Promise<void> => {
    const transition = dispatchV2Event(db, registry, tracker, event)
    // Idle-without-report nudge (parity with V1): a member that went idle
    // without ever messaging the lead gets ONE reminder to report via
    // team_message. Without this, weak models finish silently and the lead
    // waits forever — the exact failure seen live on 2026-09-14.
    if (transition && transition.to === "ready" && transition.from === "busy") {
      const entry = registry.getByName(transition.teamId, transition.memberName)
      if (entry) nudgeMember(transition.teamId, transition.memberName, entry.sessionId)
    }
    if (transition && rpc) {
      await emitMemberEvent(rpc, transition).catch(() => {
        // Companions are optional — never break the state machine for them.
      })
      if (transition.to === "ready" && transition.from === "busy") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} finished`,
          variant: "success",
        }).catch(() => undefined)
      } else if (transition.to === "error") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} errored`,
          variant: "error",
        }).catch(() => undefined)
      }
    }
  }

  // RPC bridge for terminal companions (toasts, navigation). Best-effort:
  // a failed registration must not break tools, hooks, or events.
  let rpc: { events: { emit(name: string, data: unknown): Promise<unknown> } } | null = null
  try {
    rpc = await ctx.rpc.register(EnsembleRpc, {
      summary: async (input) => {
        const team = (input as { team?: string }).team ?? ""
        const row = db.query("SELECT status FROM team WHERE name = ?").get(team) as {
          status: string
        } | null
        if (!row) return { text: `No team "${team}".` }
        const members = db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE name = ?)").all(team) as Array<{
          name: string
          status: string
        }>
        const summary = members.map((m) => `${m.name}: ${m.status}`).join(", ")
        return { text: `Team "${team}" (${row.status}): ${summary || "no members"}` }
      },
      teamContext: async (input) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? ""
        const teamInfo = findTeamBySession(db, registry, sessionID)
        if (!teamInfo) return { team: null, members: [], tasks: { pending: 0, done: 0 } }
        const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(
          teamInfo.teamId,
        ) as Array<{ name: string; status: string }>
        const pending = (
          db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status != 'completed'").get(
            teamInfo.teamId,
          ) as { c: number }
        ).c
        const done = (
          db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status = 'completed'").get(
            teamInfo.teamId,
          ) as { c: number }
        ).c
        return { team: teamInfo.teamName, members, tasks: { pending, done } }
      },
    })
  } catch (err) {
    vlog(`init:rpc:failed err=${err instanceof Error ? err.message : String(err)}`)
  }

  // Live event loop — fire-and-forget; dispose() aborts it.
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await dispatch(event)
      }
    } catch {
      // Aborted on dispose or stream error — nothing to report.
    }
  })()

  await ctx.tool.hook("execute.before", (raw) => {
    const input = raw as unknown as { tool: string; sessionID: string }
    checkToolIsolation(registry, tracker, input.tool, input.sessionID, db)
    if (input.tool.startsWith("team_")) {
      if (!rateLimiter.tryConsume()) {
        return rateLimiter.waitForToken().then(() => undefined)
      }
    }
    recordFromToolBefore({ sessionID: input.sessionID, tool: input.tool }, registry, activityBuffer)
  })

  await ctx.tool.hook("execute.after", (raw) => {
    const event = raw as unknown as {
      tool: string
      sessionID: string
      input: unknown
      status: string
      result?: { content?: string | Array<{ type?: string; text?: string }> }
      error?: { message?: unknown }
    }
    if (event.status === "error" && event.error) {
      // Weak-model arg fumbles (issue #39): the call is already dead from
      // validation, so append an explicit "the param is X, not Y" hint to
      // the error the model sees. Arguments are never rewritten — the
      // model stays in the correction loop. Fail-open by design: a
      // non-fumble error is returned untouched.
      if (enrichToolError(event.tool, event.error, event.input)) {
        vlog(`tool-arg-hint:fired tool=${event.tool} session=${event.sessionID}`)
      }
    }
    if (event.tool === "question") {
      // Feed the answer text to purge approvals (team_cleanup confirm flow).
      // The question tool renders in every client, so this is the universal
      // approval channel on V2 — no forms or TUI needed.
      purgeApprovals.recordQuestionAnswer(
        event.sessionID,
        extractQuestionOutput(event.result),
        event.input,
      )
    }
    recordFromToolAfter(
      { sessionID: event.sessionID, tool: event.tool },
      {},
      registry,
      activityBuffer,
    )
  })

  await ctx.session.hook("context", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    const prompt =
      teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId, config)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown")
    vlog(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
    event.system.push({ type: "text", text: prompt })
    if (teamInfo.role === "member") {
      // V2 invokes plugin tools through Code Mode, not direct calls —
      // without this hint teammates attempt direct calls that the runtime
      // rejects with "No tool named team_message is currently available"
      // (seen live 2026-09-14: explore scout denied twice, gave up).
      event.system.push({
        type: "text",
        text: 'Ensemble tools on this platform are called through the execute tool, e.g. tools.team_message({ to: "lead", text: "..." }). Do not call them directly.',
      })
    }
  })

  await ctx.session.hook("compaction", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName)
    event.system.push({ type: "text", text: context })
  })

  // OQ-V2-shell: the V2 shell hook carries no sessionID, so per-session
  // ENSEMBLE_* env cannot be scoped. Registered as a placeholder until the
  // API gains session scope — team tools and prompts carry identity instead.
  await ctx.shell.hook("create.before", () => undefined)

  const client = createV2Client(ctx, rpc ? { rpcEmitter: rpc } : {})
  const deps: ToolDeps = {
    db,
    registry,
    tracker,
    purgeApprovals,
    client,
    directory: ctx.location.directory,
    config,
    progressTracker,
  }
  await registerV2Tools(ctx.tool, deps)

  // Dashboard mirrors V1: main instance only, skipped when port is 0.
  let dashboard: DashboardServer | null = null
  const dashboardPort = options.dashboardPort ?? config.dashboardPort
  if (dashboardPort !== 0 && !isWorktreeInstance(ctx.location.directory)) {
    dashboard = await startDashboard(db, dashboardPort, { activityBuffer, client, host: config.dashboardHost }).catch((err) => {
      vlog(`init:dashboard:failed err=${err instanceof Error ? err.message : String(err)}`)
      return null
    })
  }

  return {
    db,
    registry,
    tracker,
    dispatch,
    dispose: async () => {
      controller.abort()
      dashboard?.stop()
    },
  }
}
