import { randomUUID } from "node:crypto"

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
const DEFAULT_PURGE_APPROVAL_TTL_MS = 10 * 60 * 1000

interface PendingPurgeApproval {
  sessionId: string
  purgeKey: string
  approved: boolean
  timeCreated: number
}

function canonicalPurgeKey(purge: string[]): string {
  if (purge.includes("*")) return JSON.stringify(["*"])
  return JSON.stringify([...new Set(purge)].sort())
}

function outputSelectedAnswer(output: string, label: string): boolean {
  const quoted = JSON.stringify(label)
  return output.includes(`=${quoted}`) || output.includes(`=[${quoted}]`)
}

function optionLabels(args: unknown): string[] {
  if (!args || typeof args !== "object") return []
  const questions = (args as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return []
  return questions.flatMap(question => {
    if (!question || typeof question !== "object") return []
    const options = (question as { options?: unknown }).options
    if (!Array.isArray(options)) return []
    return options.flatMap(option => {
      if (!option || typeof option !== "object") return []
      const label = (option as { label?: unknown }).label
      return typeof label === "string" ? [label] : []
    })
  })
}

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

/** Tracks pending archived-team purge confirmations between preview and execution. */
export class PendingPurgeApprovals {
  private pending = new Map<string, PendingPurgeApproval>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly createToken: () => string

  constructor(ttlMs = DEFAULT_PURGE_APPROVAL_TTL_MS, now: () => number = () => Date.now(), createToken: () => string = randomUUID) {
    this.ttlMs = ttlMs
    this.now = now
    this.createToken = createToken
  }

  /** Create a confirmation token for a purge preview. */
  create(sessionId: string, purge: string[]): string {
    this.pruneExpired()
    const token = this.createToken()
    this.pending.set(token, {
      sessionId,
      purgeKey: canonicalPurgeKey(purge),
      approved: false,
      timeCreated: this.now(),
    })
    return token
  }

  /** Return the exact user-facing answer label that approves a confirmation token. */
  approvalLabel(token: string): string {
    return `Approve purge ${token.slice(0, 8)}`
  }

  /** Return the exact user-facing answer label that denies a confirmation token. */
  denialLabel(token: string): string {
    return `Deny purge ${token.slice(0, 8)}`
  }

  /** Record a question tool answer and approve only tokens whose exact approval label was selected. */
  recordQuestionAnswer(sessionId: string, output: string, args: unknown): void {
    this.pruneExpired()
    const labels = new Set(optionLabels(args))
    for (const [token, approval] of this.pending.entries()) {
      const approvalLabel = this.approvalLabel(token)
      const denialLabel = this.denialLabel(token)
      const hasRequiredOptions = labels.has(approvalLabel) && labels.has(denialLabel)
      if (approval.sessionId === sessionId && hasRequiredOptions && outputSelectedAnswer(output, approvalLabel)) {
        approval.approved = true
      }
    }
  }

  /** Consume a confirmation token once it is safe to execute the matching purge. */
  consume(sessionId: string, token: string, purge: string[]): void {
    this.pruneExpired()
    const approval = this.pending.get(token)
    if (!approval || approval.sessionId !== sessionId || approval.purgeKey !== canonicalPurgeKey(purge)) {
      throw new Error("Purge confirmation token is invalid or expired.")
    }
    if (!approval.approved) {
      throw new Error("Purge was not approved by the user. Use the question tool with the exact approval option from the preview before confirming.")
    }
    this.pending.delete(token)
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [token, approval] of this.pending.entries()) {
      if (approval.timeCreated < cutoff) this.pending.delete(token)
    }
  }
}
