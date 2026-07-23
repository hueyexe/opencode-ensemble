import type { Database } from "./db"

/**
 * Release all in-progress tasks assigned to a departing member back to the
 * shared pool. Sets status to 'pending' and clears the assignee so another
 * teammate can claim the work. Completed, cancelled, and blocked tasks are
 * left untouched. Returns the number of tasks released.
 *
 * Call this whenever a member reaches a terminal state (shutdown, timeout,
 * crash recovery, or spawn rollback) so their unfinished work is not stranded
 * as permanently in_progress with a dead assignee (issue #27).
 */
export function releaseMemberTasks(db: Database, teamId: string, memberName: string): number {
  const result = db.run(
    "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status = 'in_progress'",
    [Date.now(), teamId, memberName],
  )
  return result.changes
}
