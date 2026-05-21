import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import type { Database } from "../src/db"
import { setupDb, insertTeam, insertMember } from "./helpers"
import { startDashboard } from "../src/dashboard"

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
interface StateResponse { teams: Array<{ id: string; name: string; status: string; timeCreated: number; timeUpdated: number; members: Array<Record<string, unknown>>; tasks: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> }> }

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
      expect(body).toEqual({ teams: [] })
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
      expect(team.status).toBe("active")
      expect(typeof team.timeCreated).toBe("number")
      expect(typeof team.timeUpdated).toBe("number")

      expect(team.members).toHaveLength(1)
      expect(team.members[0]!.name).toBe("alice")
      expect(team.members[0]!.agent).toBe("build")
      expect(team.members[0]!.status).toBe("busy")
      expect(team.members[0]!.executionStatus).toBe("running")

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
})
