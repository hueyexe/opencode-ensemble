import { describe, test, expect, beforeEach } from "bun:test"
import { setupDb, insertTeam } from "./helpers"
import type { Database } from "../src/db"
import { releaseMemberTasks } from "../src/tasks"

function insertTask(
  db: Database,
  teamId: string,
  id: string,
  status: string,
  assignee: string | null,
): void {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?, ?, ?, ?, 'medium', ?, ?, ?)",
    [id, teamId, `content-${id}`, status, assignee, Date.now(), Date.now()],
  )
}

describe("releaseMemberTasks", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("resets a member's in_progress task back to pending and unassigns it", () => {
    insertTask(db, "t1", "task_a", "in_progress", "alice")

    const released = releaseMemberTasks(db, "t1", "alice")

    expect(released).toBe(1)
    const row = db.query("SELECT status, assignee FROM team_task WHERE id = ?").get("task_a") as { status: string; assignee: string | null }
    expect(row.status).toBe("pending")
    expect(row.assignee).toBeNull()
  })

  test("does not touch completed tasks assigned to the member", () => {
    insertTask(db, "t1", "task_done", "completed", "alice")

    const released = releaseMemberTasks(db, "t1", "alice")

    expect(released).toBe(0)
    const row = db.query("SELECT status, assignee FROM team_task WHERE id = ?").get("task_done") as { status: string; assignee: string | null }
    expect(row.status).toBe("completed")
    expect(row.assignee).toBe("alice")
  })

  test("does not touch tasks assigned to other members", () => {
    insertTask(db, "t1", "task_bob", "in_progress", "bob")

    const released = releaseMemberTasks(db, "t1", "alice")

    expect(released).toBe(0)
    const row = db.query("SELECT status, assignee FROM team_task WHERE id = ?").get("task_bob") as { status: string; assignee: string | null }
    expect(row.status).toBe("in_progress")
    expect(row.assignee).toBe("bob")
  })

  test("releases multiple in_progress tasks for the same member", () => {
    insertTask(db, "t1", "task_a", "in_progress", "alice")
    insertTask(db, "t1", "task_b", "in_progress", "alice")

    const released = releaseMemberTasks(db, "t1", "alice")

    expect(released).toBe(2)
    const rows = db.query("SELECT status FROM team_task WHERE team_id = ? AND status = 'pending'").all("t1")
    expect(rows).toHaveLength(2)
  })

  test("is scoped to the given team", () => {
    insertTeam(db, "t2", "other-team", "lead2-sess")
    insertTask(db, "t2", "task_other", "in_progress", "alice")

    const released = releaseMemberTasks(db, "t1", "alice")

    expect(released).toBe(0)
    const row = db.query("SELECT status FROM team_task WHERE id = ?").get("task_other") as { status: string }
    expect(row.status).toBe("in_progress")
  })
})
