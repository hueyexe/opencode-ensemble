import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import type { Database } from "bun:sqlite"
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
  })

  describe("GET /", () => {
    test("returns HTML content-type", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const text = await res.text()
      expect(text).toContain("<html")
    })
  })

  describe("unknown routes", () => {
    test("returns 404", async () => {
      server = await startDashboard(db, port)
      const res = await fetch(`http://localhost:${port}/nope`)
      expect(res.status).toBe(404)
    })
  })
})
