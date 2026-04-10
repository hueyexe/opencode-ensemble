/** A single model step record. */
export interface StepRecord {
  outputTokens: number
  timestamp: number
}

/**
 * In-memory tracker for teammate activity signals.
 * Used by the watchdog for stall detection.
 */
export class ProgressTracker {
  private steps = new Map<string, StepRecord[]>()
  private lastMessageAt = new Map<string, number>()
  private lastTaskAt = new Map<string, number>()
  private peerMessages = new Map<string, number[]>()
  private reported = new Set<string>()
  private chattyReported = new Set<string>()
  private readonly maxSteps: number

  constructor(maxSteps = 10) {
    this.maxSteps = maxSteps
  }

  /** Record a model step completion with output token count. Keeps last `maxSteps` entries. */
  recordStep(sessionId: string, outputTokens: number): void {
    const records = this.steps.get(sessionId) ?? []
    records.push({ outputTokens, timestamp: Date.now() })
    if (records.length > this.maxSteps) records.shift()
    this.steps.set(sessionId, records)
  }

  /** Record a peer message (not to lead). Used for chatty detection. */
  recordPeerMessage(sessionId: string): void {
    const timestamps = this.peerMessages.get(sessionId) ?? []
    timestamps.push(Date.now())
    this.peerMessages.set(sessionId, timestamps)
  }

  /** Check if agent is chatty: more than `limit` peer messages within `windowMs`. */
  isChatty(sessionId: string, limit: number, windowMs: number): boolean {
    if (limit === 0) return false
    const timestamps = this.peerMessages.get(sessionId)
    if (!timestamps) return false
    const cutoff = Date.now() - windowMs
    const recent = timestamps.filter(t => t >= cutoff)
    // Prune old timestamps
    this.peerMessages.set(sessionId, recent)
    return recent.length >= limit
  }

  /** Mark chatty as reported (avoid spam). */
  markChattyReported(sessionId: string): void {
    this.chattyReported.add(sessionId)
  }

  /** Check if chatty already reported. */
  isChattyReported(sessionId: string): boolean {
    return this.chattyReported.has(sessionId)
  }

  /** Clear chatty report (e.g., when agent sends result to lead). */
  clearChattyReport(sessionId: string): void {
    this.chattyReported.delete(sessionId)
  }

  /** Record that this member sent a team_message. Clears stall report. */
  recordMessage(sessionId: string): void {
    this.lastMessageAt.set(sessionId, Date.now())
    this.clearReport(sessionId)
  }

  /** Record that this member completed a task. Clears stall report. */
  recordTaskComplete(sessionId: string): void {
    this.lastTaskAt.set(sessionId, Date.now())
    this.clearReport(sessionId)
  }

  /** Token-based stall: last `minSteps` steps all produced < `threshold` output tokens. */
  isTokenStalled(sessionId: string, minSteps: number, threshold: number): boolean {
    const records = this.steps.get(sessionId)
    if (!records || records.length < minSteps) return false
    const recent = records.slice(-minSteps)
    return recent.every(r => r.outputTokens < threshold)
  }

  /** Time-based stall: no message or task completion within `thresholdMs` of now. */
  isTimeStalled(sessionId: string, thresholdMs: number): boolean {
    const records = this.steps.get(sessionId)
    if (!records || records.length === 0) return false

    const msgAt = this.lastMessageAt.get(sessionId) ?? 0
    const taskAt = this.lastTaskAt.get(sessionId) ?? 0
    const lastStep = records[records.length - 1]?.timestamp ?? 0
    const baseline = Math.max(msgAt, taskAt, lastStep)

    return Date.now() - baseline >= thresholdMs
  }

  /** Mark this session as reported-stalled (avoid spam). */
  markReported(sessionId: string): void {
    this.reported.add(sessionId)
  }

  /** Check if already reported. */
  isReported(sessionId: string): boolean {
    return this.reported.has(sessionId)
  }

  /** Clear stall report (called on new activity). */
  clearReport(sessionId: string): void {
    this.reported.delete(sessionId)
  }

  /** Remove all tracking for a session (on shutdown). */
  remove(sessionId: string): void {
    this.steps.delete(sessionId)
    this.lastMessageAt.delete(sessionId)
    this.lastTaskAt.delete(sessionId)
    this.peerMessages.delete(sessionId)
    this.reported.delete(sessionId)
    this.chattyReported.delete(sessionId)
  }
}
