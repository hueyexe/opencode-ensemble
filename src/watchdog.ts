import type { Database } from "bun:sqlite"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"

interface WatchdogOpts {
  db: Database
  client: PluginClient
  registry: MemberRegistry
  /** Maximum time a member can stay busy before being timed out. 0 disables. */
  ttlMs: number
  /** How often to run the check. Defaults to 60s. */
  checkIntervalMs?: number
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
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: WatchdogOpts) {
    this.db = opts.db
    this.client = opts.client
    this.registry = opts.registry
    this.ttlMs = opts.ttlMs
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000
  }

  /** Run a single check for stale busy members. */
  async check(): Promise<void> {
    if (this.ttlMs === 0) return

    const cutoff = Date.now() - this.ttlMs
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active'
         AND tm.status = 'busy'
         AND tm.time_updated < ?`
    ).all(cutoff) as Array<{ team_id: string; name: string; session_id: string }>

    for (const member of stale) {
      // Mark as timed out
      this.db.run(
        "UPDATE team_member SET status = 'error', execution_status = 'timed_out', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), member.team_id, member.name]
      )

      // Abort session (best effort)
      try {
        await this.client.session.abort({ path: { id: member.session_id } })
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

  /** Start the periodic check. */
  start(): void {
    if (this.timer) return
    if (this.ttlMs === 0) return
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
