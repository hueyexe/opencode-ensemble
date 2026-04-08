import type { Database } from "bun:sqlite"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import type { ProgressTracker } from "./progress"
import { preserveBranch, preservedBranchName } from "./tools/merge-helper"
import { sendMessage } from "./messaging"
import { log } from "./log"

interface WatchdogOpts {
  db: Database
  client: PluginClient
  registry: MemberRegistry
  /** Maximum time a member can stay busy before being timed out. 0 disables. */
  ttlMs: number
  /** How often to run the check. Defaults to 60s. */
  checkIntervalMs?: number
  /** Progress tracker for stall detection. */
  progressTracker?: ProgressTracker
  /** Stall detection threshold in ms. 0 disables. */
  stallThresholdMs?: number
  /** Min steps before token-based stall check. */
  stallMinSteps?: number
  /** Output token threshold for stall detection. */
  stallTokenThreshold?: number
  /** Project directory for git operations. */
  cwd?: string
}

/**
 * Periodic watchdog that times out teammates stuck in busy state.
 * Transitions them to error/timed_out, aborts their session, and fires a toast.
 */
export class Watchdog {
  private readonly db: Database
  private readonly client: PluginClient
  private readonly registry: MemberRegistry
  private readonly ttlMs: number
  private readonly checkIntervalMs: number
  private readonly progressTracker?: ProgressTracker
  private readonly stallThresholdMs: number
  private readonly stallMinSteps: number
  private readonly stallTokenThreshold: number
  private readonly cwd?: string
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: WatchdogOpts) {
    this.db = opts.db
    this.client = opts.client
    this.registry = opts.registry
    this.ttlMs = opts.ttlMs
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000
    this.progressTracker = opts.progressTracker
    this.stallThresholdMs = opts.stallThresholdMs ?? 0
    this.stallMinSteps = opts.stallMinSteps ?? 3
    this.stallTokenThreshold = opts.stallTokenThreshold ?? 500
    this.cwd = opts.cwd
  }

  private static STALE_THRESHOLD_MS = Number(process.env.STALE_WORKTREE_THRESHOLD_MS) || 300_000

  /** Clean up worktrees and workspaces for shutdown/error members past the stale threshold. */
  async cleanupStaleWorktrees(): Promise<void> {
    const cutoff = Date.now() - Watchdog.STALE_THRESHOLD_MS
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.worktree_dir, tm.workspace_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active'
         AND tm.status IN ('shutdown', 'error')
         AND tm.worktree_dir IS NOT NULL
         AND tm.time_updated < ?`
    ).all(cutoff) as Array<{ team_id: string; name: string; worktree_dir: string; workspace_id: string | null }>

    for (const m of stale) {
      try {
        if (m.workspace_id) {
          await this.client.workspace.remove({ id: m.workspace_id })
        }
        await this.client.worktree.remove({ worktreeRemoveInput: { directory: m.worktree_dir } })
        this.db.run(
          "UPDATE team_member SET worktree_dir = NULL, worktree_branch = NULL, workspace_id = NULL WHERE team_id = ? AND name = ?",
          [m.team_id, m.name]
        )
      } catch { /* best effort */ }
    }
  }

  /** Check for stalled busy members and escalate to lead + nudge teammate. */
  async checkStalled(): Promise<void> {
    if (!this.progressTracker || this.stallThresholdMs === 0) return

    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all() as Array<{ team_id: string; name: string; session_id: string }>

    for (const member of busy) {
      if (this.progressTracker.isReported(member.session_id)) continue

      const tokenStalled = this.progressTracker.isTokenStalled(member.session_id, this.stallMinSteps, this.stallTokenThreshold)
      const timeStalled = this.progressTracker.isTimeStalled(member.session_id, this.stallThresholdMs)

      if (!tokenStalled && !timeStalled) continue

      this.progressTracker.markReported(member.session_id)
      const reason = tokenStalled ? "low output tokens" : "no communication"

      // Nudge the teammate directly
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You appear stalled — no progress detected. Report your current status to the lead via team_message, or wrap up your work." }],
      }).catch(() => { /* best effort */ })

      // Notify the lead
      sendMessage(this.db, {
        teamId: member.team_id,
        from: "system",
        to: "lead",
        content: `Teammate "${member.name}" appears stalled (${reason}). Consider checking on them via team_message or shutting them down.`,
      })

      // Toast for the user
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} appears stalled`,
          variant: "warning",
          duration: 5000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  /** Run a single check for stale busy members. */
  async check(): Promise<void> {
    await this.cleanupStaleWorktrees()
    await this.checkStalled()
    if (this.ttlMs === 0) return

    const cutoff = Date.now() - this.ttlMs
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.worktree_branch, t.name as team_name
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active'
         AND tm.status = 'busy'
         AND tm.time_updated < ?`
    ).all(cutoff) as Array<{ team_id: string; name: string; session_id: string; worktree_branch: string | null; team_name: string }>

    for (const member of stale) {
      // Preserve branch BEFORE abort — session.abort() may destroy the worktree + branch
      if (this.cwd && member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(member.team_name, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, this.cwd)
        if (ok) {
          this.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, member.team_id, member.name])
          log(`watchdog:branch:preserved src=${member.worktree_branch} target=${safeBranch}`)
        }
      }

      // Mark as timed out
      this.db.run(
        "UPDATE team_member SET status = 'error', execution_status = 'timed_out', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), member.team_id, member.name]
      )

      // Abort session (best effort)
      try {
        await this.client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }

      // Notify
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} timed out`,
          variant: "warning",
          duration: 5000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  /** Start the periodic check. Runs stale worktree GC regardless of TTL setting. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), this.checkIntervalMs)
  }

  /** Stop the periodic check. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Whether the watchdog is currently running. */
  isRunning(): boolean {
    return this.timer !== undefined
  }
}
