import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Database } from "./db"
import { DASHBOARD_HEAD } from "./dashboard-html"
import { DASHBOARD_JS_CORE } from "./dashboard-js-core"
import { DASHBOARD_JS_EVENTS } from "./dashboard-js-events"
import { DASHBOARD_JS_RENDER } from "./dashboard-js-render"
import { log } from "./log"
import type { ActivityBuffer, ActivityEntry } from "./activity"
import type { PluginClient } from "./types"

/** Assemble the full dashboard HTML from parts. */
const DASHBOARD_HTML = DASHBOARD_HEAD + "\n<script>" + DASHBOARD_JS_CORE + DASHBOARD_JS_RENDER + DASHBOARD_JS_EVENTS + "<\/script>\n</body></html>"

interface TeamRow {
  id: string
  name: string
  project_id: string
  lead_session_id: string
  status: string
  lead_agent: string | null
  time_created: number
  time_updated: number
}

interface ProjectRow {
  id: string
  name: string
  path: string
  status: string
  time_created: number
  time_updated: number
}

interface MemberRow {
  name: string
  agent: string
  status: string
  execution_status: string
  session_id: string
  worktree_branch: string | null
  prompt: string | null
  model: string | null
  plan_approval: string
  time_created: number
  time_updated: number
  last_nudged_at: number | null
  retry_until: number | null
  retry_attempt: number | null
  retry_provider: string | null
  retry_message: string | null
}

interface TaskRow {
  id: string
  content: string
  status: string
  priority: string
  assignee: string | null
  depends_on: string | null
  time_created: number
  time_updated: number
}

interface MessageRow {
  id: string
  from_name: string
  to_name: string | null
  content: string
  delivered: number
  read: number
  time_created: number
}

function parseDependsOn(value: string | null): string[] {
  if (!value) return []

  try {
    const parsed: unknown = JSON.parse(value)

    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string")
    if (typeof parsed === "string") return [parsed]
  } catch {
    return [value]
  }

  return []
}

/**
 * Bare-integer version of the `/api/state` response shape. Bump on any
 * breaking change to the payload (field removed/renamed/retyped, not
 * additive fields). Consumers outside this repo compare this field with
 * strict equality — no semver ranges. Currently consumed externally by the
 * OpenCode sidebar TUI plugin that renders Team status from this endpoint.
 */
export const ENSEMBLE_STATE_VERSION = 1

/**
 * `/api/state` response shape. Exported and versioned because at least one
 * consumer outside this repo (an OpenCode sidebar TUI plugin) polls this
 * endpoint and depends on its shape. Treat additive-only changes as safe;
 * bump {@link ENSEMBLE_STATE_VERSION} for anything else.
 */
export interface EnsembleDashboardState {
  version: number
  projects: unknown[]
  teams: unknown[]
}

function buildState(db: Database): EnsembleDashboardState {
  const projects = db.query("SELECT id, name, path, status, time_created, time_updated FROM project ORDER BY time_updated DESC").all() as ProjectRow[]
  const teams = db.query("SELECT id, name, project_id, lead_session_id, status, lead_agent, time_created, time_updated FROM team ORDER BY time_created DESC").all() as TeamRow[]
  const memberStmt = db.query("SELECT name, agent, status, execution_status, session_id, worktree_branch, prompt, model, plan_approval, time_created, time_updated, last_nudged_at, retry_until, retry_attempt, retry_provider, retry_message FROM team_member WHERE team_id = ?")
  const taskStmt = db.query("SELECT id, content, status, priority, assignee, depends_on, time_created, time_updated FROM team_task WHERE team_id = ?")
  const msgStmt = db.query("SELECT id, from_name, to_name, content, delivered, read, time_created FROM team_message WHERE team_id = ? ORDER BY time_created DESC LIMIT 50")

  const mappedTeams = teams.map((t) => {
    const members = (memberStmt.all(t.id) as MemberRow[]).map((m) => ({
      name: m.name,
      agent: m.agent,
      status: m.status,
      executionStatus: m.execution_status,
      sessionId: m.session_id,
      worktreeBranch: m.worktree_branch,
      prompt: m.prompt,
      model: m.model,
      planApproval: m.plan_approval,
      timeCreated: m.time_created,
      timeUpdated: m.time_updated,
      lastNudgedAt: m.last_nudged_at,
      // Fix 4: derived, read-time TTL boolean (Fix 3) — never a stored enum.
      // Additive fields; existing consumers that don't know about them simply
      // don't render them.
      isRetrying: m.retry_until !== null && m.retry_until > Date.now(),
      retryUntil: m.retry_until,
      retryAttempt: m.retry_attempt,
      retryProvider: m.retry_provider,
      retryMessage: m.retry_message,
    }))
    return {
      id: t.id,
      name: t.name,
      projectId: t.project_id,
      leadSessionId: t.lead_session_id,
      status: t.status,
      leadAgent: t.lead_agent,
      timeCreated: t.time_created,
      timeUpdated: t.time_updated,
      members,
      tasks: (taskStmt.all(t.id) as TaskRow[]).map((tk) => ({
        id: tk.id,
        content: tk.content,
        status: tk.status,
        priority: tk.priority,
        assignee: tk.assignee,
        dependsOn: parseDependsOn(tk.depends_on),
        timeCreated: tk.time_created,
        timeUpdated: tk.time_updated,
      })),
      messages: (msgStmt.all(t.id) as MessageRow[]).map((msg) => ({
        id: msg.id,
        fromName: msg.from_name,
        toName: msg.to_name,
        content: msg.content,
        delivered: msg.delivered === 1,
        read: msg.read === 1,
        timeCreated: msg.time_created,
      })),
    }
  })

  const teamsByProject = new Map<string, unknown[]>()
  mappedTeams.forEach(team => {
    const projectId = (team as { projectId: string }).projectId
    teamsByProject.set(projectId, [...(teamsByProject.get(projectId) ?? []), team])
  })

  return {
    version: ENSEMBLE_STATE_VERSION,
    projects: projects.flatMap(project => {
      const projectTeams = teamsByProject.get(project.id) ?? []
      if (projectTeams.length === 0) return []
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        status: project.status,
        timeCreated: project.time_created,
        timeUpdated: project.time_updated,
        activeTeams: projectTeams.filter(team => (team as { status: string }).status === "active").length,
        workingAgents: projectTeams.reduce<number>((count, team) => {
          const members = (team as { members: Array<{ status: string }> }).members
          return count + members.filter(member => member.status === "busy").length
        }, 0),
        teams: projectTeams,
      }
    }),
    teams: mappedTeams,
  }
}

/** Dashboard server handle returned by startDashboard. */
export interface DashboardServer {
  stop(force?: boolean): void
}

/** Optional dependencies for the dashboard server. */
export interface DashboardOptions {
  /** In-memory activity buffer for real-time per-session events. */
  activityBuffer?: ActivityBuffer
  /** SDK client for on-demand session message retrieval. */
  client?: PluginClient
}

function sendJson(res: ServerResponse, data: unknown): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  })
  res.end(JSON.stringify(data))
}

/** Parse SDK message parts into ActivityEntry format for the fallback path. */
export function parseMessageParts(parts: unknown[], msgInfo: unknown): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  const info = (msgInfo ?? {}) as { time?: string; role?: string; tokens?: { input?: number; output?: number } }
  const timestamp = info.time ? new Date(info.time).getTime() : Date.now()

  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue
    const p = part as {
      type?: string
      tool?: string
      state?: { status?: string; input?: unknown; output?: unknown; error?: string; title?: string }
      text?: string
      path?: string
      content?: string
      diff?: string
      label?: string
      step?: string
    }

    if (p.type === "tool" && p.tool) {
      const state = p.state ?? {}
      const inputStr = typeof state.input === "string" ? state.input : state.input != null ? JSON.stringify(state.input, null, 2) : undefined
      const outputStr = typeof state.output === "string" ? state.output : state.output != null ? JSON.stringify(state.output, null, 2) : undefined
      entries.push({
        type: state.status === "completed" ? "tool_result" : "tool_call",
        tool: p.tool,
        title: state.title,
        input: inputStr,
        output: outputStr,
        error: state.error,
        timestamp,
      })
    } else if (p.type === "reasoning" && p.text) {
      entries.push({ type: "reasoning", reasoning: p.text, timestamp })
    } else if (p.type === "file" && (p.path || p.content || p.diff)) {
      entries.push({
        type: "file",
        filePath: p.path,
        fileContent: p.content,
        fileDiff: p.diff,
        timestamp,
      })
    } else if (p.type === "text" && p.text) {
      entries.push({ type: "text", text: p.text, role: info.role, timestamp })
    } else if (p.type === "step-start") {
      entries.push({ type: "step", title: p.label ?? p.step ?? "step", timestamp })
    } else if (p.type === "step-finish") {
      entries.push({ type: "step", title: p.label ?? p.step ?? "step complete", timestamp })
    }
  }
  return entries
}

/** Handle the /api/session/:sessionId/activity endpoint. */
async function handleActivityRoute(
  sessionId: string,
  options: DashboardOptions | undefined,
  res: ServerResponse,
): Promise<void> {
  const buffer = options?.activityBuffer
  const client = options?.client

  const buffered = buffer?.getActivity(sessionId) ?? []

  let sessionData: unknown = null
  let fallbackActivity: ActivityEntry[] = []

  if (client) {
    try {
      const [msgResult, getResult] = await Promise.all([
        client.session.messages({ sessionID: sessionId, limit: 100 }),
        client.session.get({ sessionID: sessionId }),
      ])
      const messages = msgResult.data ?? []
      for (const msg of messages) {
        const parts = msg.parts ?? []
        fallbackActivity.push(...parseMessageParts(parts, msg.info))
      }
      sessionData = getResult.data ?? null
    } catch { /* best effort — return what we have */ }
  }

  const combined = [...buffered, ...fallbackActivity].sort((a, b) => a.timestamp - b.timestamp)

  sendJson(res, { activity: combined, session: sessionData })
}

function handleDashboardRequest(
  db: Database,
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
  options?: DashboardOptions,
): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`)

  if (url.pathname === "/api/health") {
    sendJson(res, { ensemble: true, pid: process.pid })
    return
  }

  if (url.pathname === "/api/state") {
    sendJson(res, buildState(db))
    return
  }

  const activityMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/activity$/)
  if (activityMatch) {
    const sessionId = decodeURIComponent(activityMatch[1]!)
    handleActivityRoute(sessionId, options, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Failed to fetch activity" }))
      }
    })
    return
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(DASHBOARD_HTML)
    return
  }

  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not Found")
}

function toDashboardServer(server: Server): DashboardServer {
  return {
    stop(force?: boolean) {
      server.close()
      // server.close() only stops accepting new connections — under Node's
      // node:http, idle keep-alive sockets keep the listener busy until the
      // keep-alive timeout. closeAllConnections() (Node ≥ 18.2) terminates
      // them promptly, matching the behaviour Bun.serve().stop(true) had.
      if (force) {
        const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections
        if (typeof closeAll === "function") closeAll.call(server)
      }
    },
  }
}

/**
 * Start the dashboard HTTP server.
 * Serves a JSON API for team state, session activity, and the dashboard HTML.
 * Singleton: if the port is already in use by another ensemble instance, skips silently.
 * Returns the server instance, or null if skipped.
 */
export async function startDashboard(db: Database, port: number, options?: DashboardOptions): Promise<DashboardServer | null> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handleDashboardRequest(db, port, req, res, options))

    server.once("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        try {
          const res = await fetch(`http://localhost:${port}/api/health`)
          const data = await res.json() as { ensemble?: boolean; pid?: number }
          if (data.ensemble && data.pid) {
            // Check if the other process is still alive
            let alive = false
            try { process.kill(data.pid, 0); alive = true } catch { /* process is dead */ }
            if (alive && data.pid !== process.pid) {
              log(`dashboard:already-running port=${port} pid=${data.pid}`)
              resolve(null)
              return
            }
            // Stale server from a dead process — warn the user
            log(`dashboard:stale-server port=${port} stale-pid=${data.pid} — run: kill -9 ${data.pid} || lsof -ti:${port} | xargs kill -9`)
            resolve(null)
            return
          }
        } catch { /* health check failed — port held by something else */ }
        log(`dashboard:port-in-use port=${port} (not an ensemble instance)`)
        resolve(null)
        return
      }

      log(`dashboard:failed err=${err.message}`)
      resolve(null)
    })

    server.listen(port, () => {
      log(`dashboard:started port=${port} url=http://localhost:${port}`)
      resolve(toDashboardServer(server))
    })
  })
}
