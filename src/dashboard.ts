import type { Database } from "bun:sqlite"
import { DASHBOARD_HEAD } from "./dashboard-html"
import { DASHBOARD_JS_PART1 } from "./dashboard-js-part1"
import { DASHBOARD_JS_PART2 } from "./dashboard-js-part2"
import { DASHBOARD_JS_PART3 } from "./dashboard-js-part3"
import { log } from "./log"

/** Assemble the full dashboard HTML from parts. */
const DASHBOARD_HTML = DASHBOARD_HEAD + "\n<script>" + DASHBOARD_JS_PART1 + DASHBOARD_JS_PART2 + DASHBOARD_JS_PART3 + "<\/script>\n</body></html>"

interface TeamRow {
  id: string
  name: string
  status: string
  lead_agent: string | null
  time_created: number
  time_updated: number
}

interface MemberRow {
  name: string
  agent: string
  status: string
  execution_status: string
  worktree_branch: string | null
  prompt: string | null
  model: string | null
  plan_approval: string
  time_created: number
  time_updated: number
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

function buildState(db: Database): { teams: unknown[] } {
  const teams = db.query("SELECT id, name, status, lead_agent, time_created, time_updated FROM team ORDER BY time_created DESC").all() as TeamRow[]
  const memberStmt = db.query("SELECT name, agent, status, execution_status, worktree_branch, prompt, model, plan_approval, time_created, time_updated FROM team_member WHERE team_id = ?")
  const taskStmt = db.query("SELECT id, content, status, priority, assignee, depends_on, time_created, time_updated FROM team_task WHERE team_id = ?")
  const msgStmt = db.query("SELECT id, from_name, to_name, content, delivered, read, time_created FROM team_message WHERE team_id = ? ORDER BY time_created DESC LIMIT 50")

  return {
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      leadAgent: t.lead_agent,
      timeCreated: t.time_created,
      timeUpdated: t.time_updated,
      members: (memberStmt.all(t.id) as MemberRow[]).map((m) => ({
        name: m.name,
        agent: m.agent,
        status: m.status,
        executionStatus: m.execution_status,
        worktreeBranch: m.worktree_branch,
        prompt: m.prompt,
        model: m.model,
        planApproval: m.plan_approval,
        timeCreated: m.time_created,
        timeUpdated: m.time_updated,
      })),
      tasks: (taskStmt.all(t.id) as TaskRow[]).map((tk) => ({
        id: tk.id,
        content: tk.content,
        status: tk.status,
        priority: tk.priority,
        assignee: tk.assignee,
        dependsOn: tk.depends_on,
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
    })),
  }
}

/**
 * Start the dashboard HTTP server.
 * Serves a JSON API for team state and the dashboard HTML.
 * Singleton: if the port is already in use by another ensemble instance, skips silently.
 * Returns the server instance, or null if skipped.
 */
export async function startDashboard(db: Database, port: number): Promise<ReturnType<typeof Bun.serve> | null> {
  try {
    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/api/health") {
          return jsonResponse({ ensemble: true, pid: process.pid })
        }

        if (url.pathname === "/api/state") {
          return jsonResponse(buildState(db))
        }

        if (url.pathname === "/") {
          return new Response(DASHBOARD_HTML, {
            headers: { "Content-Type": "text/html" },
          })
        }

        return new Response("Not Found", { status: 404 })
      },
    })
    log(`dashboard:started port=${port} url=http://localhost:${port}`)
    return server
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") {
      try {
        const res = await fetch(`http://localhost:${port}/api/health`)
        const data = await res.json() as { ensemble?: boolean; pid?: number }
        if (data.ensemble && data.pid) {
          // Check if the other process is still alive
          let alive = false
          try { process.kill(data.pid, 0); alive = true } catch { /* process is dead */ }
          if (alive && data.pid !== process.pid) {
            log(`dashboard:already-running port=${port} pid=${data.pid}`)
            return null
          }
          // Stale server from a dead process — warn the user
          log(`dashboard:stale-server port=${port} stale-pid=${data.pid} — run: kill -9 ${data.pid} || lsof -ti:${port} | xargs kill -9`)
          return null
        }
      } catch { /* health check failed — port held by something else */ }
      log(`dashboard:port-in-use port=${port} (not an ensemble instance)`)
      return null
    }
    log(`dashboard:failed err=${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
