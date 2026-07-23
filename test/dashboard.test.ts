import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import type { Database } from "../src/db"
import { setupDb, insertTeam, insertMember, mockClient } from "./helpers"
import { startDashboard, parseMessageParts } from "../src/dashboard"
import { ActivityBuffer } from "../src/activity"
import type { PluginClient } from "../src/types"

function randomPort(): number {
  return 19000 + Math.floor(Math.random() * 10000)
}

function insertTask(db: Database, teamId: string, id: string, content: string, status = "pending", priority = "medium", assignee: string | null = null, dependsOn: string | null = null) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, teamId, content, status, priority, assignee, dependsOn, Date.now(), Date.now()]
  )
}

function insertMessage(db: Database, teamId: string, id: string, fromName: string, toName: string | null, content: string) {
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [id, teamId, fromName, toName, content, Date.now()]
  )
}

// biome-lint: use Record for JSON response shape
interface HealthResponse { ensemble: boolean; pid: number }
interface DashboardTeam { id: string; name: string; projectId: string; leadSessionId?: string; status: string; timeCreated: number; timeUpdated: number; members: Array<{ sessionId?: string } & Record<string, unknown>>; tasks: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> }
interface StateResponse { version: number; projects: Array<{ id: string; name: string; path: string; activeTeams: number; workingAgents: number; teams: DashboardTeam[] }>; teams: DashboardTeam[] }

describe("dashboard", () => {
  let db: Database
  let port: number
  let server: Awaited<ReturnType<typeof startDashboard>>

  beforeEach(() => {
    db = setupDb()
    port = randomPort()
  })

  afterEach(() => {
    server?.stop(true)
    db.close()
  })

  describe("GET /api/health", () => {
    test("returns correct shape with ensemble: true", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/health`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
      const body = (await res.json()) as HealthResponse
      expect(body.ensemble).toBe(true)
      expect(typeof body.pid).toBe("number")
    })
  })

  describe("GET /api/state", () => {
    test("returns empty teams array when no teams exist", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
      const body = (await res.json()) as StateResponse
      expect(body).toEqual({ version: 1, projects: [], teams: [] })
    })

    test("returns team with members, tasks, messages", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")
      insertTask(db, "t1", "task-1", "Fix auth", "in_progress", "high", "alice")
      insertMessage(db, "t1", "msg-1", "alice", "lead", "Done with auth fix")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams).toHaveLength(1)
      const team = body.teams[0]!
      expect(team.id).toBe("t1")
      expect(team.name).toBe("alpha")
      expect(team.projectId).toBe("/tmp/test-project")
      expect(team.status).toBe("active")
      expect(typeof team.timeCreated).toBe("number")
      expect(typeof team.timeUpdated).toBe("number")

      expect(team.members).toHaveLength(1)
      expect(team.members[0]!.name).toBe("alice")
      expect(team.members[0]!.agent).toBe("build")
      expect(team.members[0]!.status).toBe("busy")
      expect(team.members[0]!.executionStatus).toBe("running")
      expect(team.members[0]!.lastNudgedAt).toBeNull()

      expect(team.tasks).toHaveLength(1)
      expect(team.tasks[0]!.id).toBe("task-1")
      expect(team.tasks[0]!.content).toBe("Fix auth")
      expect(team.tasks[0]!.status).toBe("in_progress")
      expect(team.tasks[0]!.priority).toBe("high")
      expect(team.tasks[0]!.assignee).toBe("alice")

      expect(team.messages).toHaveLength(1)
      expect(team.messages[0]!.id).toBe("msg-1")
      expect(team.messages[0]!.fromName).toBe("alice")
      expect(team.messages[0]!.toName).toBe("lead")
      expect(team.messages[0]!.content).toBe("Done with auth fix")
      expect(body.projects).toHaveLength(1)
      expect(body.projects[0]!.id).toBe("/tmp/test-project")
      expect(body.projects[0]!.path).toBe("/tmp/test-project")
      expect(body.projects[0]!.activeTeams).toBe(1)
      expect(body.projects[0]!.workingAgents).toBe(1)
      expect(body.projects[0]!.teams[0]!.id).toBe("t1")
    })

    test("Fix 1: exposes last_nudged_at as an additive lastNudgedAt field", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")
      const nudgedAt = Date.now() - 5000
      db.run("UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?", [nudgedAt, "t1", "alice"])

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams[0]!.members[0]!.lastNudgedAt).toBe(nudgedAt)
    })

    test("Fix 4: exposes retry_* columns additively, with isRetrying derived at read time", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")
      const futureRetryAt = Date.now() + 30_000
      db.run(
        "UPDATE team_member SET retry_until = ?, retry_attempt = ?, retry_provider = ?, retry_message = ? WHERE team_id = ? AND name = ?",
        [futureRetryAt, 2, "anthropic", "Anthropic is currently overloaded", "t1", "alice"]
      )

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse
      const member = body.teams[0]!.members[0]! as unknown as {
        isRetrying: boolean; retryUntil: number; retryAttempt: number; retryProvider: string; retryMessage: string
      }

      expect(member.isRetrying).toBe(true)
      expect(member.retryUntil).toBe(futureRetryAt)
      expect(member.retryAttempt).toBe(2)
      expect(member.retryProvider).toBe("anthropic")
      expect(member.retryMessage).toBe("Anthropic is currently overloaded")
    })

    test("Fix 4/Fix 3: isRetrying reads false once retry_until has elapsed, with no explicit clear-write", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")
      const pastRetryAt = Date.now() - 5000
      db.run(
        "UPDATE team_member SET retry_until = ?, retry_attempt = ?, retry_provider = ?, retry_message = ? WHERE team_id = ? AND name = ?",
        [pastRetryAt, 1, "openai", "rate limited", "t1", "alice"]
      )

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse
      const member = body.teams[0]!.members[0]! as unknown as { isRetrying: boolean; retryUntil: number }

      // Column is untouched (no clear-write happened) but the derived boolean flipped.
      expect(member.retryUntil).toBe(pastRetryAt)
      expect(member.isRetrying).toBe(false)
    })

    test("Fix 4: retry fields are null/false for a member that has never retried", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse
      const member = body.teams[0]!.members[0]! as unknown as {
        isRetrying: boolean; retryUntil: number | null; retryAttempt: number | null; retryProvider: string | null; retryMessage: string | null
      }

      expect(member.isRetrying).toBe(false)
      expect(member.retryUntil).toBeNull()
      expect(member.retryAttempt).toBeNull()
      expect(member.retryProvider).toBeNull()
      expect(member.retryMessage).toBeNull()
    })

    test("summarizes progress across projects", async () => {
      insertTeam(db, "t1", "alpha", "lead-1")
      db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
      db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-a", "t1"])
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")

      insertTeam(db, "t2", "beta", "lead-2")
      db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
      db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-b", "t2"])
      insertMember(db, "t2", "bob", "sess-b", "ready", "idle")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      const projects = [...body.projects].sort((a, b) => a.id.localeCompare(b.id))
      expect(projects.map(project => ({ id: project.id, activeTeams: project.activeTeams, workingAgents: project.workingAgents }))).toEqual([
        { id: "/tmp/project-a", activeTeams: 1, workingAgents: 1 },
        { id: "/tmp/project-b", activeTeams: 1, workingAgents: 0 },
      ])
      expect(body.teams.map(team => team.projectId).sort()).toEqual(["/tmp/project-a", "/tmp/project-b"])
    })

    test("returns archived teams", async () => {
      insertTeam(db, "t1", "old-team", "lead-sess", "archived")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams).toHaveLength(1)
      expect(body.teams[0]!.status).toBe("archived")
    })

    test("messages limited to last 50", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      for (let i = 0; i < 60; i++) {
        insertMessage(db, "t1", `msg-${i}`, "alice", "lead", `Message ${i}`)
      }

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams[0]!.messages).toHaveLength(50)
    })

    test("returns multiple teams", async () => {
      insertTeam(db, "t1", "alpha", "lead-1")
      insertTeam(db, "t2", "beta", "lead-2")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams).toHaveLength(2)
    })

    test("returns task dependencies as readable id arrays", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertTask(db, "t1", "task-1", "Prepare dashboard contracts", "completed", "high")
      insertTask(db, "t1", "task-2", "Run final verification", "blocked", "high", null, JSON.stringify(["task-1"]))

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams[0]!.tasks[1]!.dependsOn).toEqual(["task-1"])
    })
  })

  describe("GET /", () => {
    test("returns HTML content-type", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const text = await res.text()
      expect(text).toContain("<html")
      expect(text).toContain('id="attention"')
      expect(text).toContain('aria-label="Team attention"')
      expect(text).toContain('aria-label="Agent roster"')
      expect(text).toContain('aria-label="Task board"')
      expect(text).toContain('aria-label="Activity feed"')
      expect(text).toContain('aria-label="Event timeline"')
      expect(text).toContain('id="drawer-title"')
    })
  })

  describe("unknown routes", () => {
    test("returns 404", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/nope`)
      expect(res.status).toBe(404)
    })
  })

  describe("stop(force)", () => {
    test("stop(true) closes in-flight sockets so the port frees up promptly", async () => {
      server = await startDashboard(db, port)
      expect(server).toBeTruthy()

      // Open a raw TCP socket to the dashboard and leave it dangling.
      // node:http with keep-alive will keep the listener busy until the
      // keep-alive timeout if we only call server.close() — server.stop(true)
      // must call closeAllConnections() to terminate this socket promptly.
      const net = await import("node:net")
      const dangling = await new Promise<import("node:net").Socket>((resolve, reject) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
          sock.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n")
        })
        sock.on("error", reject)
        sock.once("data", () => resolve(sock))
      })

      // Forcefully stop within a short window. server.close() alone would
      // wait for the keep-alive socket to drain (default 5s in node:http).
      const stopStart = Date.now()
      server!.stop(true)
      server = null
      const stopElapsed = Date.now() - stopStart

      // Cleanup the dangling socket
      dangling.destroy()

      // The synchronous stop() call returns immediately — the assertion
      // is that a new server can bind to the same port without waiting.
      expect(stopElapsed).toBeLessThan(500)

      // Probe the port directly with a fresh listener. Avoids racing the
      // full dashboard startup against an arbitrary timer under CI load.
      // Tries up to 3 times to absorb brief TIME_WAIT / cross-test races.
      const tryProbe = async (): Promise<boolean> => {
        const probe = net.createServer()
        const ok = await new Promise<boolean>((resolve) => {
          probe.once("error", () => resolve(false))
          probe.listen(port, "127.0.0.1", () => resolve(true))
        })
        await new Promise<void>((r) => probe.close(() => r()))
        return ok
      }
      let probeBound = await tryProbe()
      for (let i = 0; !probeBound && i < 2; i++) {
        await new Promise((r) => setTimeout(r, 50))
        probeBound = await tryProbe()
      }

      expect(probeBound).toBe(true)
    })
  })

  describe("GET /api/session/:sessionId/activity", () => {
    test("returns buffered activity entries", async () => {
      const buf = new ActivityBuffer()
      buf.record("sess-a", { type: "tool_call", tool: "bash", title: "Run tests", timestamp: Date.now() })
      buf.record("sess-a", { type: "tool_result", tool: "bash", output: "all pass", timestamp: Date.now() + 100 })

      server = await startDashboard(db, port, { activityBuffer: buf })
      const res = await fetch(`http://localhost:${port}/api/session/sess-a/activity`)
      expect(res.status).toBe(200)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      expect(body.activity).toHaveLength(2)
      expect(body.activity[0]!.type).toBe("tool_call")
      expect(body.activity[1]!.type).toBe("tool_result")
    })

    test("returns empty array when buffer has no entries and no client", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/session/unknown/activity`)
      expect(res.status).toBe(200)
      const body = await res.json() as { activity: Array<unknown> }
      expect(body.activity).toEqual([])
    })

    test("falls back to session.messages when buffer is empty", async () => {
      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(opts: { sessionID: string }) {
            return {
              data: [
                {
                  info: { role: "assistant", id: "msg-1" },
                  parts: [
                    { type: "tool", tool: "bash", state: { status: "completed", output: "done", title: "Run build", input: "bun run build" } },
                    { type: "text", text: "Build complete" },
                  ],
                },
              ],
            }
          },
          async get(_opts: { sessionID: string }) {
            return { data: { cost: 0.05, tokens: { input: 100, output: 200 } } }
          },
        },
      }

      server = await startDashboard(db, port, { client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-x/activity`)
      expect(res.status).toBe(200)
      const body = await res.json() as { activity: Array<Record<string, unknown>>; session: Record<string, unknown> | null }
      expect(body.activity.length).toBeGreaterThan(0)
      expect(body.session).toBeTruthy()
      expect(body.session!.cost).toBe(0.05)
    })

    test("combines buffer entries with session.messages fallback", async () => {
      const buf = new ActivityBuffer()
      buf.record("sess-c", { type: "shell_command", command: "ls -la", timestamp: Date.now() })

      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(_opts: { sessionID: string }) {
            return { data: [] }
          },
          async get(_opts: { sessionID: string }) {
            return { data: null }
          },
        },
      }

      server = await startDashboard(db, port, { activityBuffer: buf, client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-c/activity`)
      expect(res.status).toBe(200)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      expect(body.activity).toHaveLength(1)
      expect(body.activity[0]!.type).toBe("shell_command")
    })

    test("parses reasoning parts from session messages", async () => {
      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(_opts: { sessionID: string }) {
            return {
              data: [{
                info: { role: "assistant", time: new Date().toISOString() },
                parts: [
                  { type: "reasoning", text: "I should check the file first." },
                  { type: "text", text: "Let me look at the handler." },
                ],
              }],
            }
          },
          async get(_opts: { sessionID: string }) {
            return { data: null }
          },
        },
      }

      server = await startDashboard(db, port, { client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-r/activity`)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      const reasoning = body.activity.find(a => a.type === "reasoning")
      expect(reasoning).toBeTruthy()
      expect(reasoning!.reasoning).toBe("I should check the file first.")
      const text = body.activity.find(a => a.type === "text")
      expect(text).toBeTruthy()
      expect(text!.text).toBe("Let me look at the handler.")
      expect(text!.role).toBe("assistant")
    })

    test("parses file parts from session messages", async () => {
      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(_opts: { sessionID: string }) {
            return {
              data: [{
                info: { role: "assistant", time: new Date().toISOString() },
                parts: [
                  { type: "file", path: "src/handler.ts", content: "export function handle() {}" },
                ],
              }],
            }
          },
          async get(_opts: { sessionID: string }) {
            return { data: null }
          },
        },
      }

      server = await startDashboard(db, port, { client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-f/activity`)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      const file = body.activity.find(a => a.type === "file")
      expect(file).toBeTruthy()
      expect(file!.filePath).toBe("src/handler.ts")
      expect(file!.fileContent).toBe("export function handle() {}")
    })

    test("parses structured tool input/output from session messages", async () => {
      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(_opts: { sessionID: string }) {
            return {
              data: [{
                info: { role: "assistant", time: new Date().toISOString() },
                parts: [
                  { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: { stdout: "file.ts" } } },
                ],
              }],
            }
          },
          async get(_opts: { sessionID: string }) {
            return { data: null }
          },
        },
      }

      server = await startDashboard(db, port, { client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-t/activity`)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      const tool = body.activity.find(a => a.type === "tool_result")
      expect(tool).toBeTruthy()
      expect(tool!.tool).toBe("bash")
      expect(tool!.input).toBe(JSON.stringify({ command: "ls" }, null, 2))
      expect(tool!.output).toBe(JSON.stringify({ stdout: "file.ts" }, null, 2))
    })
  })

  describe("state includes sessionId", () => {
    test("member objects include sessionId", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess")
      insertMember(db, "t1", "alice", "sess-a", "busy", "running")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      expect(body.teams[0]!.members[0]!.sessionId).toBe("sess-a")
    })
  })

  describe("state includes leadSessionId", () => {
    test("team objects include leadSessionId, scoping to the session that created them", async () => {
      insertTeam(db, "t1", "alpha", "lead-sess-a")
      insertTeam(db, "t2", "beta", "lead-sess-b")

      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse

      const teamA = body.teams.find((t) => t.id === "t1")
      const teamB = body.teams.find((t) => t.id === "t2")
      expect(teamA?.leadSessionId).toBe("lead-sess-a")
      expect(teamB?.leadSessionId).toBe("lead-sess-b")
    })
  })

  describe("state includes version", () => {
    test("top-level response carries a bare-integer version field", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/api/state`)
      const body = (await res.json()) as StateResponse & { version: number }

      expect(typeof body.version).toBe("number")
      expect(Number.isInteger(body.version)).toBe(true)
      expect(body.version).toBe(1)
    })
  })

  describe("parseMessageParts", () => {
    test("parses step-start parts", () => {
      const entries = parseMessageParts(
        [{ type: "step-start", label: "Plan", step: "1" }],
        { time: new Date().toISOString() },
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("step")
      expect(entries[0]!.title).toBe("Plan")
    })

    test("parses step-finish parts", () => {
      const entries = parseMessageParts(
        [{ type: "step-finish", label: "Plan", step: "1" }],
        { time: new Date().toISOString() },
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("step")
      expect(entries[0]!.title).toBe("Plan")
    })

    test("parses file parts with diff", () => {
      const entries = parseMessageParts(
        [{ type: "file", path: "src/handler.ts", diff: "@@ -1 +1 @@" }],
        { time: new Date().toISOString() },
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("file")
      expect(entries[0]!.filePath).toBe("src/handler.ts")
      expect(entries[0]!.fileDiff).toBe("@@ -1 +1 @@")
    })

    test("handles malformed parts gracefully", () => {
      const entries = parseMessageParts(
        [null, undefined, "string", 42, { type: "unknown" }, { type: "tool" }],
        { time: new Date().toISOString() },
      )
      expect(entries).toHaveLength(0)
    })

    test("uses info.time.created (SDK object shape) for the timestamp", () => {
      const created = 1_700_000_000_000
      const entries = parseMessageParts(
        [{ type: "text", text: "hello" }],
        { role: "assistant", time: { created } },
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]!.timestamp).toBe(created)
    })

    test("does not produce a NaN/epoch timestamp for the SDK object shape", () => {
      const entries = parseMessageParts(
        [{ type: "text", text: "hi" }],
        { role: "assistant", time: { created: 1_700_000_000_000 } },
      )
      expect(Number.isNaN(entries[0]!.timestamp)).toBe(false)
      expect(entries[0]!.timestamp).toBeGreaterThan(0)
    })

    test("falls back to a sane timestamp when time is missing", () => {
      const before = Date.now()
      const entries = parseMessageParts([{ type: "text", text: "hi" }], { role: "assistant" })
      expect(entries[0]!.timestamp).toBeGreaterThanOrEqual(before)
    })
  })

  describe("GET /api/session/:sessionId/activity — edge cases", () => {
    test("sorts combined entries by timestamp", async () => {
      const buf = new ActivityBuffer()
      // Buffer entry with later timestamp
      buf.record("sess-sort", { type: "shell_command", command: "ls", timestamp: 3000 })
      // Session message with earlier timestamp
      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(_opts: { sessionID: string }) {
            return {
              data: [{
                info: { role: "assistant", time: new Date(1000).toISOString() },
                parts: [{ type: "text", text: "hello" }],
              }],
            }
          },
          async get(_opts: { sessionID: string }) {
            return { data: null }
          },
        },
      }

      server = await startDashboard(db, port, { activityBuffer: buf, client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-sort/activity`)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      expect(body.activity).toHaveLength(2)
      // Earlier timestamp (1000) should come first
      expect(body.activity[0]!.timestamp).toBe(1000)
      expect(body.activity[1]!.timestamp).toBe(3000)
    })

    test("decodes URL-encoded session IDs", async () => {
      const buf = new ActivityBuffer()
      buf.record("sess/with/slash", { type: "shell_command", command: "ls", timestamp: 1000 })

      server = await startDashboard(db, port, { activityBuffer: buf })
      const res = await fetch(`http://localhost:${port}/api/session/sess%2Fwith%2Fslash/activity`)
      expect(res.status).toBe(200)
      const body = await res.json() as { activity: Array<Record<string, unknown>> }
      expect(body.activity).toHaveLength(1)
    })

    test("returns 500 when activity route throws", async () => {
      const mockPluginClient: PluginClient = {
        ...mockClient(),
        session: {
          ...mockClient().session,
          async messages(_opts: { sessionID: string }) {
            throw new Error("network failure")
          },
          async get(_opts: { sessionID: string }) {
            throw new Error("network failure")
          },
        },
      }

      server = await startDashboard(db, port, { client: mockPluginClient })
      const res = await fetch(`http://localhost:${port}/api/session/sess-err/activity`)
      // The error is caught — returns what we have (empty activity)
      expect(res.status).toBe(200)
      const body = await res.json() as { activity: unknown[]; session: unknown }
      expect(body.activity).toEqual([])
      expect(body.session).toBeNull()
    })
  })
})
