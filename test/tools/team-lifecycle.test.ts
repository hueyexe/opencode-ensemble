import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamShutdown } from "../../src/tools/team-shutdown"
import { executeTeamCleanup } from "../../src/tools/team-cleanup"
import type { MergeBranchFn, DeleteBranchFn } from "../../src/tools/merge-helper"

/** Noop merge fn for tests that don't need real git. */
const noopMerge: MergeBranchFn = async () => ({ ok: true })
const noopDelete: DeleteBranchFn = async () => true
const noopListBranches = async () => []
/** Noop preserve fn for shutdown tests. */
const noopPreserve = async () => true

function insertTask(db: ReturnType<typeof setupDeps>["db"], teamId: string, id: string) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)",
    [id, teamId, Date.now(), Date.now()]
  )
}

function insertMessage(db: ReturnType<typeof setupDeps>["db"], teamId: string, id: string) {
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, 'alice', 'lead', 'done', 1, ?)",
    [id, teamId, Date.now()]
  )
}

function extractConfirmToken(preview: string): string {
  const match = preview.match(/Confirmation token: (\S+)/)
  if (!match?.[1]) throw new Error("Expected purge preview to include a confirmation token")
  return match[1]
}

function purgeQuestionArgs(approvalLabel: string, denialLabel: string) {
  return {
    questions: [{
      question: "Delete archived teams?",
      header: "Confirm Purge",
      options: [
        { label: approvalLabel, description: "Delete the archived teams." },
        { label: denialLabel, description: "Keep the archived teams." },
      ],
      multiple: false,
    }],
  }
}

async function preparePurgeConfirmation(deps: ReturnType<typeof setupDeps>, purge: string[], sessionId = "main-sess"): Promise<string> {
  const preview = await executeTeamCleanup(deps, { force: false, purge }, sessionId, undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches)
  const token = extractConfirmToken(preview)
  const approvalLabel = deps.purgeApprovals.approvalLabel(token)
  const denialLabel = deps.purgeApprovals.denialLabel(token)
  deps.purgeApprovals.recordQuestionAnswer(sessionId, `User has answered your questions: "Delete?"="${approvalLabel}".`, purgeQuestionArgs(approvalLabel, denialLabel))
  return token
}

describe("team_shutdown", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("busy member with default force=false sends shutdown message, no abort", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve)
    expect(result).toContain("Shutdown requested")
    expect(result).toContain("alice")

    // Should send promptAsync with shutdown message, NOT abort
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })

  test("idle member is aborted immediately, no promptAsync", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve)
    expect(result).toContain("shut down")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("rejects if caller is not the lead", async () => {
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "bob", "sess-bob")

    await expect(executeTeamShutdown(deps, { member: "alice" }, "sess-bob", undefined, noopPreserve))
      .rejects.toThrow("Only the team lead")
  })

  test("rejects if member not found", async () => {
    await expect(executeTeamShutdown(deps, { member: "unknown" }, "lead-sess", undefined, noopPreserve))
      .rejects.toThrow("not found")
  })

  test("rejects if member already shutdown", async () => {
    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE name = 'alice'")
    await expect(executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve))
      .rejects.toThrow("already shut down")
  })

  test("handles abort failure gracefully on idle member", async () => {
    // Status says idle, so we try to abort, but abort fails
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }
    deps.client.session.abort = async () => { throw new Error("session gone") }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve)
    // Should still transition to shutdown since member was idle
    expect(result).toContain("shut down")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("falls back to shutdown_requested when status poll fails", async () => {
    deps.client.session.status = async () => { throw new Error("status failed") }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve)
    // Can't determine idle/busy, so treat as busy → graceful shutdown
    expect(result).toContain("Shutdown requested")

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })

  test("busy member with force=true aborts immediately, no promptAsync", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice", force: true }, "lead-sess", undefined, noopPreserve)
    expect(result).toContain("shut down")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("member already shutdown_requested → second call forces abort", async () => {
    // Set alice to shutdown_requested (as if first graceful call already happened)
    deps.db.run("UPDATE team_member SET status = 'shutdown_requested' WHERE name = 'alice'")

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve)
    expect(result).toContain("Force shut down")
    expect(result).toContain("alice")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    const row = deps.db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(row.status).toBe("shutdown")
  })

  test("shutdown message content contains [Shutdown requested] and instructions", async () => {
    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", undefined, noopPreserve)

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const text = (promptCalls[0]!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text
    expect(text).toContain("[Shutdown requested]")
    expect(text).toContain("team_message")
  })

  // --- Dirty worktree warning tests ---

  test("shutdown warns about uncommitted changes when worktree is dirty", async () => {
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])

    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", async () => true, noopPreserve)

    expect(result).toContain("shut down")
    expect(result).toContain("uncommitted")
    expect(result).toContain("alice")
  })

  test("shutdown does not warn when worktree is clean", async () => {
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])

    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "idle" } } }
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", async () => false, noopPreserve)

    expect(result).toContain("shut down")
    expect(result).not.toContain("uncommitted")
  })
})

describe("team_cleanup", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("archives team when all members are shutdown", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")

    // Registry should be cleared
    expect(deps.registry.isTeamSession("sess-alice")).toBe(false)
  })

  test("rejects if active members exist and force=false", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")

    await expect(executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false))
      .rejects.toThrow("still active")
  })

  test("force=true aborts active members and archives", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    insertMember(deps.db, "t1", "bob", "sess-bob", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")

    const result = await executeTeamCleanup(deps, { force: true }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1) // only alice was active

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  test("rejects if caller is not the lead", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    await expect(executeTeamCleanup(deps, { force: false }, "sess-alice", undefined, noopMerge, noopDelete, false))
      .rejects.toThrow("Only the team lead")
  })

  test("works with no members", async () => {
    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")
  })

  test("treats empty purge array as normal cleanup", async () => {
    const result = await executeTeamCleanup(deps, { force: false, purge: [] }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  test("treats shutdown_requested members as inactive (cleanup succeeds without force)", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown_requested", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  test("treats error members as inactive (cleanup succeeds without force)", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "error", "failed")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  // --- Worktree cleanup tests ---

  test("removes worktrees and lists branches for merging on cleanup", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)
  })

  test("cleanup continues if worktree removal fails", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    deps.client.worktree.remove = async () => { throw new Error("worktree gone") }

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")
  })

  test("cleanup with no worktrees does not mention branches", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")
  })

  test("nulls worktree_dir in DB after successful worktree removal", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)

    const row = deps.db.query("SELECT worktree_dir FROM team_member WHERE name = 'alice'").get() as { worktree_dir: string | null }
    expect(row.worktree_dir).toBeNull()
  })

  test("calls workspace.remove for members with workspace_id on cleanup", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ?, workspace_id = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice", "ws-alice-123"])
    deps.registry.register("t1", "alice", "sess-alice")

    await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)

    const wsRemoveCalls = deps.client.calls.filter(c => c.method === "workspace.remove")
    expect(wsRemoveCalls).toHaveLength(1)
    expect((wsRemoveCalls[0]!.args[0] as { id: string }).id).toBe("ws-alice-123")
  })

  test("nulls workspace_id in DB after successful workspace removal", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ?, workspace_id = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice", "ws-alice-123"])
    deps.registry.register("t1", "alice", "sess-alice")

    await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)

    const row = deps.db.query("SELECT workspace_id FROM team_member WHERE name = 'alice'").get() as { workspace_id: string | null }
    expect(row.workspace_id).toBeNull()
  })

  test("cleanup continues if workspace.remove fails", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ?, workspace_id = ? WHERE name = 'alice'",
      ["/tmp/worktree-alice", "ensemble-my-team-alice", "ws-alice-123"])
    deps.registry.register("t1", "alice", "sess-alice")

    deps.client.workspace.remove = async () => { throw new Error("workspace gone") }

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")
  })

  test("cleanup lists multiple branches when multiple members have worktrees", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    insertMember(deps.db, "t1", "bob", "sess-bob", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'bob'",
      ["/tmp/wt-bob", "ensemble-my-team-bob"])
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", undefined, noopMerge, noopDelete, false)
    expect(result).toContain("cleaned up")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(2)
  })

  // --- Dirty worktree protection tests ---

  test("blocks cleanup and warns when worktree has uncommitted changes", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", async () => true, noopMerge, noopDelete, false)

    // Should warn, NOT remove worktree, NOT archive team
    expect(result).toContain("uncommitted")
    expect(result).toContain("alice")
    expect(result).toContain("acknowledge_uncommitted")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(0)

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("active")
  })

  test("force=true still blocks on dirty worktrees (does not abort sessions or remove worktrees)", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: true }, "lead-sess", async () => true, noopMerge, noopDelete, false)

    // Dirty check runs BEFORE abort — sessions should NOT be aborted
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(0)

    // Should warn about dirty worktree, NOT remove it
    expect(result).toContain("uncommitted")
    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(0)

    // Team should NOT be archived
    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("active")
  })

  test("acknowledge_uncommitted=true proceeds despite dirty worktrees", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false, acknowledge_uncommitted: true }, "lead-sess", async () => true, noopMerge, noopDelete, false)

    expect(result).toContain("cleaned up")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as Record<string, string>
    expect(team.status).toBe("archived")
  })

  test("clean worktrees proceed without acknowledge_uncommitted", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE name = 'alice'",
      ["/tmp/wt-alice", "ensemble-my-team-alice"])
    deps.registry.register("t1", "alice", "sess-alice")

    const result = await executeTeamCleanup(deps, { force: false }, "lead-sess", async () => false, noopMerge, noopDelete, false)

    expect(result).toContain("cleaned up")

    const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)
  })

  // --- Archived team purge tests ---

  test("purge first call previews without deleting even when approval callback is available", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    insertTask(deps.db, "old-1", "task-old-1")
    insertMessage(deps.db, "old-1", "msg-old-1")

    const result = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Purge preview")
    expect(result).toContain("Use the question tool")
    expect(result).toContain("confirm_token")
    expect(result).toContain("Approve purge")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("confirmed purge rejects without a confirmation token even when approval callback is available", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"], confirm_purge: true }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches))
      .rejects.toThrow("confirmation token")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("confirmed purge rejects if the question tool was not used after preview", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const preview = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches)
    const token = extractConfirmToken(preview)

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches))
      .rejects.toThrow("approved")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("confirmed purge rejects if the user selected the denial answer", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const preview = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches)
    const token = extractConfirmToken(preview)

    deps.purgeApprovals.recordQuestionAnswer("main-sess", `User has answered your questions: "Delete?"="${deps.purgeApprovals.denialLabel(token)}".`, purgeQuestionArgs(deps.purgeApprovals.approvalLabel(token), deps.purgeApprovals.denialLabel(token)))

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches))
      .rejects.toThrow("approved")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("confirmed purge deletes an archived team and cascades child records", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    insertTask(deps.db, "old-1", "task-old-1")
    insertMessage(deps.db, "old-1", "msg-old-1")
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    const result = await executeTeamCleanup(deps, { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Permanently deleted 1 archived team")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).toBeNull()
    expect(deps.db.query("SELECT team_id FROM team_member WHERE team_id = 'old-1'").all()).toHaveLength(0)
    expect(deps.db.query("SELECT team_id FROM team_task WHERE team_id = 'old-1'").all()).toHaveLength(0)
    expect(deps.db.query("SELECT team_id FROM team_message WHERE team_id = 'old-1'").all()).toHaveLength(0)
  })

  test("purge wildcard deletes all archived teams and leaves active teams", async () => {
    insertTeam(deps.db, "old-1", "old-one", "old-lead-1", "archived")
    insertTeam(deps.db, "old-2", "old-two", "old-lead-2", "archived")
    const token = await preparePurgeConfirmation(deps, ["*"], "lead-sess")

    const result = await executeTeamCleanup(deps, { force: false, purge: ["*"], confirm_purge: true, confirm_token: token }, "lead-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Permanently deleted 2 archived teams")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).toBeNull()
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-2'").get()).toBeNull()
    expect(deps.db.query("SELECT id FROM team WHERE id = 't1'").get()).not.toBeNull()
  })

  test("purge wildcard rejects if archived targets changed after preview", async () => {
    insertTeam(deps.db, "old-1", "old-one", "old-lead-1", "archived")
    const token = await preparePurgeConfirmation(deps, ["*"], "lead-sess")
    insertTeam(deps.db, "old-2", "old-two", "old-lead-2", "archived")

    await expect(executeTeamCleanup(deps, { force: false, purge: ["*"], confirm_purge: true, confirm_token: token }, "lead-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches))
      .rejects.toThrow("confirmation token")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-2'").get()).not.toBeNull()
  })

  test("purge rejects wildcard mixed with explicit team names", async () => {
    insertTeam(deps.db, "old-1", "old-one", "old-lead-1", "archived")

    await expect(executeTeamCleanup(deps, { force: false, purge: ["*", "my-team"] }, "lead-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}))
      .rejects.toThrow("Wildcard purge cannot be combined")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
    expect(deps.db.query("SELECT id FROM team WHERE id = 't1'").get()).not.toBeNull()
  })

  test("purge rejects active teams and leaves archived targets untouched", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team", "my-team"] }, "main-sess", undefined, noopMerge, noopDelete, false))
      .rejects.toThrow("Cannot purge active team")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
    const active = deps.db.query("SELECT status FROM team WHERE id = 't1'").get() as { status: string }
    expect(active.status).toBe("active")
  })

  test("purge rejects missing teams and leaves valid archived targets untouched", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team", "missing-team"] }, "main-sess", undefined, noopMerge, noopDelete, false))
      .rejects.toThrow("Team not found")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge rejects active team members", async () => {
    insertMember(deps.db, "t1", "alice", "sess-alice", "ready", "idle")
    deps.registry.register("t1", "alice", "sess-alice")
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "sess-alice", undefined, noopMerge, noopDelete, false))
      .rejects.toThrow("Team members cannot purge archived teams")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge without confirmation returns preview and leaves archived team intact", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")

    const result = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Purge preview")
    expect(result).toContain("Use the question tool")
    expect(result).toContain("confirm_token")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge denial answer deletes nothing", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const preview = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches)
    const token = extractConfirmToken(preview)
    deps.purgeApprovals.recordQuestionAnswer("main-sess", `User has answered your questions: "Delete?"="${deps.purgeApprovals.denialLabel(token)}".`, purgeQuestionArgs(deps.purgeApprovals.approvalLabel(token), deps.purgeApprovals.denialLabel(token)))

    await expect(executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      noopDelete,
      false,
      undefined,
      undefined,
      noopListBranches
    )).rejects.toThrow("approved")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge preview includes destructive action details", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    insertTask(deps.db, "old-1", "task-old-1")
    insertMessage(deps.db, "old-1", "msg-old-1")

    const preview = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches)

    expect(preview).toContain("Permanently delete archived teams")
    expect(preview).toContain("old-team")
    expect(preview).toContain("1 member")
    expect(preview).toContain("1 task")
    expect(preview).toContain("1 message")
  })

  test("purge preview pluralizes branch counts correctly", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")

    const preview = await executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"] },
      "main-sess",
      undefined,
      noopMerge,
      noopDelete,
      false,
      undefined,
      undefined,
      async () => ["ensemble/preserved/old-team/alice", "ensemble/preserved/old-team/bob"],
    )

    expect(preview).toContain("2 preserved branches")
    expect(preview).toContain("0 stale branches")
    expect(preview).not.toContain("branchs")
  })

  test("purge blocks if preserved branch listing fails", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    await expect(executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      noopDelete,
      false,
      undefined,
      async () => {},
      async () => { throw new Error("git failed") }
    )).rejects.toThrow("Failed to list preserved branches")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge treats non-git directories as having no preserved branches", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    const result = await executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      noopDelete,
      false,
      undefined,
      async () => {},
      async () => { throw new Error("fatal: not a git repository (or any of the parent directories): .git") }
    )

    expect(result).toContain("Permanently deleted 1 archived team")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).toBeNull()
  })

  test("purge revalidates active status after approval", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const token = await preparePurgeConfirmation(deps, ["old-team"])
    deps.db.run("UPDATE team SET status = 'active' WHERE id = 'old-1'")

    await expect(executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      noopDelete,
      false,
      undefined,
      undefined,
      noopListBranches
    )).rejects.toThrow("Cannot purge active team")

    const team = deps.db.query("SELECT status FROM team WHERE id = 'old-1'").get() as { status: string }
    expect(team.status).toBe("active")
  })

  test("purge cleans stale worktree resources added after approval", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    const token = await preparePurgeConfirmation(deps, ["old-team"])
    deps.db.run("UPDATE team_member SET worktree_dir = ? WHERE team_id = 'old-1' AND name = 'alice'", ["/tmp/wt-alice"])
    deps.client.worktree.list = async () => {
      deps.client.calls.push({ method: "worktree.list", args: [] })
      return { data: [{ name: "ensemble-old-team-alice", branch: "ensemble-old-team-alice", directory: "/tmp/wt-alice" }] }
    }

    const result = await executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      noopDelete,
      false,
      undefined,
      undefined,
      noopListBranches
    )

    expect(result).toContain("Permanently deleted 1 archived team")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).toBeNull()
    expect(deps.client.calls.filter(c => c.method === "worktree.remove")).toHaveLength(1)
  })

  test("purge previews teams that still reference a stale worktree directory", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ? WHERE team_id = 'old-1' AND name = 'alice'", ["/tmp/wt-alice"])

    const result = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Purge preview")
    expect(result).toContain("1 stale resource")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge previews teams that still reference a stale workspace", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET workspace_id = ? WHERE team_id = 'old-1' AND name = 'alice'", ["ws-alice"])

    const result = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Purge preview")
    expect(result).toContain("1 stale resource")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge aborts before DB deletion if stale worktree removal fails", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ? WHERE team_id = 'old-1' AND name = 'alice'", ["/tmp/wt-alice"])
    deps.client.worktree.list = async () => ({ data: [{ name: "ensemble-old-team-alice", branch: "ensemble-old-team-alice", directory: "/tmp/wt-alice" }] })
    deps.client.worktree.remove = async () => { throw new Error("remove failed") }
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches))
      .rejects.toThrow("Failed to remove stale worktree")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge blocks existing stale worktrees with uncommitted changes", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ? WHERE team_id = 'old-1' AND name = 'alice'", ["/tmp/wt-alice"])
    deps.client.worktree.list = async () => ({ data: [{ name: "ensemble-old-team-alice", branch: "ensemble-old-team-alice", directory: "/tmp/wt-alice" }] })
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token }, "main-sess", async () => true, noopMerge, noopDelete, false, undefined, undefined, noopListBranches))
      .rejects.toThrow("uncommitted changes")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
    expect(deps.client.calls.filter(c => c.method === "worktree.remove")).toHaveLength(0)
  })

  test("purge blocks stale resources that are referenced by active teams", async () => {
    insertMember(deps.db, "t1", "active-alice", "sess-active", "ready", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, workspace_id = ? WHERE team_id = 't1' AND name = 'active-alice'", ["/tmp/shared-wt", "ws-shared"])
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_dir = ?, workspace_id = ? WHERE team_id = 'old-1' AND name = 'alice'", ["/tmp/shared-wt", "ws-shared"])

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, undefined, noopListBranches))
      .rejects.toThrow("referenced by active team")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge blocks non-preserved worktree branches", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = 'old-1' AND name = 'alice'", ["feature/alice"])

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}))
      .rejects.toThrow("non-preserved worktree branch")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge previews stale Ensemble-owned branch references", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = 'old-1' AND name = 'alice'", ["opencode/ensemble-old-team-alice"])

    const result = await executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}, noopListBranches)

    expect(result).toContain("Purge preview")
    expect(result).toContain("1 stale branch")
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("confirmed purge deletes stale Ensemble-owned branch references", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = 'old-1' AND name = 'alice'", ["opencode/ensemble-old-team-alice"])
    const token = await preparePurgeConfirmation(deps, ["old-team"])
    const deleted: string[] = []

    const result = await executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      async (branch) => { deleted.push(branch); return true },
      false,
      undefined,
      undefined,
      noopListBranches,
      async () => true,
    )

    expect(result).toContain("Permanently deleted 1 archived team")
    expect(deleted).toEqual(["opencode/ensemble-old-team-alice"])
    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).toBeNull()
  })

  test("purge aborts before DB deletion if stale Ensemble-owned branch deletion fails", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = 'old-1' AND name = 'alice'", ["opencode/ensemble-old-team-alice"])
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    await expect(executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      async () => false,
      false,
      undefined,
      undefined,
      noopListBranches,
      async () => true,
    )).rejects.toThrow("Failed to delete stale Ensemble branch")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge blocks preserved branch references for a different team namespace", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    insertMember(deps.db, "old-1", "alice", "old-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = 'old-1' AND name = 'alice'", ["ensemble/preserved/other-team/alice"])

    await expect(executeTeamCleanup(deps, { force: false, purge: ["old-team"] }, "main-sess", undefined, noopMerge, noopDelete, false, undefined, async () => {}))
      .rejects.toThrow("outside its preserved namespace")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })

  test("purge deletes only preserved branches for the target team", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const deleted: string[] = []
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    await executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      async (branch) => { deleted.push(branch); return true },
      false,
      undefined,
      async () => {},
      async () => ["ensemble/preserved/old-team/alice", "feature/unrelated", "ensemble/preserved/other-team/bob"]
    )

    expect(deleted).toEqual(["ensemble/preserved/old-team/alice"])
  })

  test("purge aborts before DB deletion if preserved branch deletion fails", async () => {
    insertTeam(deps.db, "old-1", "old-team", "old-lead", "archived")
    const token = await preparePurgeConfirmation(deps, ["old-team"])

    await expect(executeTeamCleanup(
      deps,
      { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token },
      "main-sess",
      undefined,
      noopMerge,
      async () => false,
      false,
      undefined,
      async () => {},
      async () => ["ensemble/preserved/old-team/alice"]
    )).rejects.toThrow("Failed to delete preserved branch")

    expect(deps.db.query("SELECT id FROM team WHERE id = 'old-1'").get()).not.toBeNull()
  })
})
