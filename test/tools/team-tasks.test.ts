import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamTasksList } from "../../src/tools/team-tasks-list"
import { executeTeamTasksAdd } from "../../src/tools/team-tasks-add"
import { executeTeamTasksComplete } from "../../src/tools/team-tasks-complete"
import { executeTeamClaim } from "../../src/tools/team-claim"

describe("team_tasks_list", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("returns empty message when no tasks", async () => {
    const result = await executeTeamTasksList(deps, "sess-alice")
    expect(result).toContain("No tasks")
  })

  test("lists tasks with status and assignee", async () => {
    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
      { content: "Write docs", priority: "low" },
    ] }, "sess-alice")

    const result = await executeTeamTasksList(deps, "sess-alice")
    expect(result).toContain("Fix bug")
    expect(result).toContain("Write docs")
    expect(result).toContain("pending")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamTasksList(deps, "random-sess"))
      .rejects.toThrow("not in a team")
  })
})

describe("team_tasks_add", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("adds tasks and returns IDs", async () => {
    const result = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
      { content: "Task B", priority: "medium" },
    ] }, "sess-alice")

    expect(result).toContain("Added 2 task")
    const rows = deps.db.query("SELECT * FROM team_task WHERE team_id = ?").all("t1")
    expect(rows).toHaveLength(2)
  })

  test("adds tasks with dependencies", async () => {
    const result1 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    // Extract the task ID from the result
    const idMatch = result1.match(/task_\S+/)
    expect(idMatch).toBeTruthy()
    const taskAId = idMatch![0]

    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "medium", depends_on: [taskAId!] },
    ] }, "sess-alice")

    const taskB = deps.db.query("SELECT * FROM team_task WHERE content = ?").get("Task B") as Record<string, unknown>
    expect(taskB.depends_on).toBeTruthy()
    expect(taskB.status).toBe("blocked")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "x", priority: "medium" }] }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("lead can add tasks", async () => {
    const result = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Lead task", priority: "high" },
    ] }, "lead-sess")
    expect(result).toContain("Added 1 task")
  })
})

describe("team_tasks_complete", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("marks a task as completed", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    // Claim it first
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")

    const result = await executeTeamTasksComplete(deps, { task_id: taskId }, "sess-alice")
    expect(result).toContain("Completed")
    expect(result).toContain("Fix bug")

    const row = deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId) as Record<string, string>
    expect(row.status).toBe("completed")
  })

  test("fires a progress toast on completion", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
      { content: "Task B", priority: "high" },
    ] }, "sess-alice")
    const taskIds = [...addResult.matchAll(/task_[a-z0-9_]+/g)].map(m => m[0])

    await executeTeamClaim(deps, { task_id: taskIds[0]! }, "sess-alice")
    await executeTeamTasksComplete(deps, { task_id: taskIds[0]! }, "sess-alice")

    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts.length).toBeGreaterThanOrEqual(1)
    const last = toasts[toasts.length - 1]!.args[0] as { message: string }
    expect(last.message).toContain("1/2 tasks complete")
  })

  test("unblocks dependent tasks when completed", async () => {
    const r1 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    const taskAId = r1.match(/task_\S+/)![0]!

    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "medium", depends_on: [taskAId] },
    ] }, "sess-alice")

    // Task B should be blocked
    const taskBBefore = deps.db.query("SELECT status FROM team_task WHERE content = ?").get("Task B") as Record<string, string>
    expect(taskBBefore.status).toBe("blocked")

    // Claim and complete Task A
    await executeTeamClaim(deps, { task_id: taskAId }, "sess-alice")
    await executeTeamTasksComplete(deps, { task_id: taskAId }, "sess-alice")

    // Task B should now be pending
    const taskBAfter = deps.db.query("SELECT status FROM team_task WHERE content = ?").get("Task B") as Record<string, string>
    expect(taskBAfter.status).toBe("pending")
  })

  test("rejects if task not found", async () => {
    await expect(executeTeamTasksComplete(deps, { task_id: "nonexistent" }, "sess-alice"))
      .rejects.toThrow("not found")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamTasksComplete(deps, { task_id: "x" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })
})

describe("team_claim", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("claims a pending task", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    const result = await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    expect(result).toContain("Claimed")
    expect(result).toContain("Fix bug")

    const row = deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId) as Record<string, string>
    expect(row.status).toBe("in_progress")
    expect(row.assignee).toBe("alice")
  })

  test("rejects claiming an already-claimed task", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    await expect(executeTeamClaim(deps, { task_id: taskId }, "sess-bob"))
      .rejects.toThrow("not pending")
  })

  test("rejects claiming a blocked task", async () => {
    const r1 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    const taskAId = r1.match(/task_\S+/)![0]!

    const r2 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "medium", depends_on: [taskAId] },
    ] }, "sess-alice")
    const taskBId = r2.match(/task_\S+/)![0]!

    await expect(executeTeamClaim(deps, { task_id: taskBId }, "sess-alice"))
      .rejects.toThrow("blocked")
  })

  test("rejects if task not found", async () => {
    await expect(executeTeamClaim(deps, { task_id: "nonexistent" }, "sess-alice"))
      .rejects.toThrow("not found")
  })

  test("race condition: two concurrent claims, only one succeeds", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Contested task", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    const results = await Promise.allSettled([
      executeTeamClaim(deps, { task_id: taskId }, "sess-alice"),
      executeTeamClaim(deps, { task_id: taskId }, "sess-bob"),
    ])

    const fulfilled = results.filter(r => r.status === "fulfilled")
    const rejected = results.filter(r => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})
