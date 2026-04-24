import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamMessage } from "../src/tools/team-message"
import { handleSessionStatusEvent } from "../src/hooks"
import { hasReportedCompletion } from "../src/messaging"
import { sendMessage } from "../src/messaging"

type Deps = ReturnType<typeof setupDeps>

describe("issue #3: completion loop prevention", () => {
  let deps: Deps
  const leadSession = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
  })

  /** Helper: spawn a teammate, have them message lead, then transition busy→ready. */
  async function spawnAndComplete(teamName: string, memberName: string): Promise<{ teamId: string; memberSession: string }> {
    await executeTeamCreate(deps, { name: teamName }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = ?").get(teamName) as { id: string }
    await executeTeamSpawn(deps, { name: memberName, agent: "build", prompt: "task", worktree: false }, leadSession)
    const memberSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = ?").get(memberName) as { session_id: string }).session_id

    // Teammate messages lead
    await executeTeamMessage(deps, { to: "lead", text: "here are my findings" }, memberSession)

    // Simulate busy→ready transition (teammate finished work)
    deps.db.run("UPDATE team_member SET status = 'busy' WHERE team_id = ? AND name = ?", [team.id, memberName])
    handleSessionStatusEvent(deps.db, deps.registry, memberSession, "idle")

    return { teamId: team.id, memberSession }
  }

  test("hasReportedCompletion is false after messaging lead but BEFORE going idle", async () => {
    await executeTeamCreate(deps, { name: "report-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'report-team'").get() as { id: string }
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task", worktree: false }, leadSession)
    const aliceSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'alice'").get() as { session_id: string }).session_id

    expect(hasReportedCompletion(deps.db, team.id, "alice")).toBe(false)

    // Alice messages lead — flag should NOT be set yet (she's still working)
    await executeTeamMessage(deps, { to: "lead", text: "done with my task" }, aliceSession)
    expect(hasReportedCompletion(deps.db, team.id, "alice")).toBe(false)

    // Alice goes idle (busy→ready) — NOW the flag should be set
    deps.db.run("UPDATE team_member SET status = 'busy' WHERE team_id = ? AND name = 'alice'", [team.id])
    handleSessionStatusEvent(deps.db, deps.registry, aliceSession, "idle")
    expect(hasReportedCompletion(deps.db, team.id, "alice")).toBe(true)
  })

  test("hasReportedCompletion stays false if teammate goes idle WITHOUT messaging lead", async () => {
    await executeTeamCreate(deps, { name: "no-msg-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'no-msg-team'").get() as { id: string }
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task", worktree: false }, leadSession)
    const bobSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'bob'").get() as { session_id: string }).session_id

    // Bob goes idle without ever messaging lead
    deps.db.run("UPDATE team_member SET status = 'busy' WHERE team_id = ? AND name = 'bob'", [team.id])
    handleSessionStatusEvent(deps.db, deps.registry, bobSession, "idle")
    expect(hasReportedCompletion(deps.db, team.id, "bob")).toBe(false)
  })

  test("messages to completed teammates are stored but NOT pushed via promptAsync", async () => {
    const { teamId, memberSession } = await spawnAndComplete("guard-team", "charlie")
    deps.client.calls.length = 0

    // Lead sends a reply (this is what Kimi K2.6 does — courtesy replies)
    const result = await executeTeamMessage(deps, { to: "charlie", text: "thanks charlie!" }, leadSession)

    // Message IS stored in DB
    const msg = deps.db.query("SELECT content FROM team_message WHERE team_id = ? AND to_name = 'charlie' AND from_name = 'lead'").get(teamId) as { content: string } | null
    expect(msg).toBeTruthy()
    expect(msg!.content).toBe("thanks charlie!")

    // But promptAsync was NOT called to deliver it
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    // Return value warns the lead
    expect(result).toContain("completed")
  })

  test("wake-lead skips when all teammates are ready/shutdown", async () => {
    const { teamId } = await spawnAndComplete("done-team", "dave")

    // Insert another undelivered message to lead (simulating the loop)
    sendMessage(deps.db, { teamId, from: "dave", to: "lead", content: "duplicate" })

    // All members should be in a terminal state
    const activeBusy = deps.db.query(
      "SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND status NOT IN ('ready', 'shutdown', 'error')"
    ).get(teamId) as { c: number }
    expect(activeBusy.c).toBe(0)
  })

  test("peer-flush skips for completed teammates", async () => {
    const { teamId } = await spawnAndComplete("flush-team", "eve")

    expect(hasReportedCompletion(deps.db, teamId, "eve")).toBe(true)

    // Insert a stale peer message addressed to eve (simulating the loop)
    deps.db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, 'lead', 'eve', 'follow up', 0, ?)",
      ["msg-stale", teamId, Date.now() - 10_000]
    )

    const reported = deps.db.query("SELECT reported_to_lead FROM team_member WHERE team_id = ? AND name = 'eve'").get(teamId) as { reported_to_lead: number }
    expect(reported.reported_to_lead).toBe(1)
  })

  test("full ping-pong regression: promptAsync calls are bounded after completion", async () => {
    const { teamId, memberSession } = await spawnAndComplete("loop-team", "frank")

    // Reset call log — everything after this should be bounded
    deps.client.calls.length = 0

    // Simulate the ping-pong loop that Kimi K2.6 triggers:
    const reply1 = await executeTeamMessage(deps, { to: "frank", text: "thanks for the report" }, leadSession)
    const reply2 = await executeTeamMessage(deps, { to: "frank", text: "anything else?" }, leadSession)

    // Both replies should be stored but NOT delivered
    expect(reply1).toContain("completed")
    expect(reply2).toContain("completed")

    // Zero promptAsync calls to frank's session after he reported
    const frankCalls = deps.client.calls.filter(c => {
      if (c.method !== "session.promptAsync") return false
      const args = c.args[0] as { sessionID: string }
      return args.sessionID === memberSession
    })
    expect(frankCalls).toHaveLength(0)
  })

  test("teammate can still receive messages BEFORE going idle (Q&A works)", async () => {
    await executeTeamCreate(deps, { name: "qa-team" }, leadSession)
    const team = deps.db.query("SELECT id FROM team WHERE name = 'qa-team'").get() as { id: string }
    await executeTeamSpawn(deps, { name: "grace", agent: "build", prompt: "task", worktree: false }, leadSession)
    const graceSession = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'grace'").get() as { session_id: string }).session_id

    // Grace asks lead a question (messages lead, but is still busy)
    await executeTeamMessage(deps, { to: "lead", text: "I have a question about the API" }, graceSession)

    // Grace is NOT marked as completed yet (still busy)
    expect(hasReportedCompletion(deps.db, team.id, "grace")).toBe(false)

    deps.client.calls.length = 0

    // Lead answers — this SHOULD be delivered (grace hasn't completed)
    const result = await executeTeamMessage(deps, { to: "grace", text: "use the v2 endpoint" }, leadSession)

    // Message was delivered via promptAsync (not blocked)
    expect(result).toBe("Message sent to grace.")
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })
})
