/** Info about a registered team member in the in-memory registry. */
export interface MemberEntry {
  teamId: string
  memberName: string
  sessionId: string
}

/**
 * In-memory registry of team members, indexed by sessionID and by (teamId, name).
 * This is the fast-path lookup used by hooks and tools — SQLite is the source of truth.
 */
export class MemberRegistry {
  private bySession = new Map<string, MemberEntry>()
  private byTeamName = new Map<string, MemberEntry>()

  /** Register a member. */
  register(teamId: string, name: string, sessionId: string): void {
    const entry: MemberEntry = { teamId, memberName: name, sessionId }
    this.bySession.set(sessionId, entry)
    this.byTeamName.set(`${teamId}:${name}`, entry)
  }

  /** Look up a member by session ID. */
  getBySession(sessionId: string): MemberEntry | undefined {
    return this.bySession.get(sessionId)
  }

  /** Look up a member by team ID and name. */
  getByName(teamId: string, name: string): MemberEntry | undefined {
    return this.byTeamName.get(`${teamId}:${name}`)
  }

  /** List all members for a team. */
  listByTeam(teamId: string): MemberEntry[] {
    const result: MemberEntry[] = []
    for (const entry of this.bySession.values()) {
      if (entry.teamId === teamId) result.push(entry)
    }
    return result
  }

  /** Remove a member by session ID. */
  unregister(sessionId: string): void {
    const entry = this.bySession.get(sessionId)
    if (!entry) return
    this.bySession.delete(sessionId)
    this.byTeamName.delete(`${entry.teamId}:${entry.memberName}`)
  }

  /** Remove all members for a team. */
  unregisterTeam(teamId: string): void {
    for (const entry of this.listByTeam(teamId)) {
      this.bySession.delete(entry.sessionId)
      this.byTeamName.delete(`${teamId}:${entry.memberName}`)
    }
  }

  /** Check if a session ID belongs to a registered team member. */
  isTeamSession(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  /** Get all registered session IDs. */
  allSessionIds(): Set<string> {
    return new Set(this.bySession.keys())
  }
}

const DEFAULT_MAX_DEPTH = 10

/**
 * Tracks parent-child session relationships for sub-agent isolation.
 * Used to walk the parent chain and determine if a session is a descendant
 * of a team member session.
 */
export class DescendantTracker {
  private parents = new Map<string, string>()

  /** Record that childId's parent is parentId. */
  track(childId: string, parentId: string): void {
    this.parents.set(childId, parentId)
  }

  /** Get the parent of a session. */
  getParent(sessionId: string): string | undefined {
    return this.parents.get(sessionId)
  }

  /**
   * Walk the parent chain from sessionId. Returns true if any ancestor
   * (up to maxDepth) is in the given set of session IDs.
   */
  isDescendantOf(sessionId: string, ancestors: Set<string>, maxDepth = DEFAULT_MAX_DEPTH): boolean {
    let current = sessionId
    for (let i = 0; i < maxDepth; i++) {
      const parent = this.parents.get(current)
      if (!parent) return false
      if (ancestors.has(parent)) return true
      current = parent
    }
    return false
  }

  /** Remove a session from tracking. */
  remove(sessionId: string): void {
    this.parents.delete(sessionId)
  }
}
