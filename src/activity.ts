/**
 * A single activity event captured per session for the dashboard verbose view.
 */
export interface ActivityEntry {
  /** The kind of activity being recorded. */
  type: "tool_call" | "tool_result" | "shell_command" | "step"
  /** Tool name (for tool_call / tool_result types). */
  tool?: string
  /** Human-readable title for the activity. */
  title?: string
  /** Input text for a tool call. */
  input?: string
  /** Output text for a tool result. */
  output?: string
  /** Error message if the activity failed. */
  error?: string
  /** Shell command string (for shell_command type). */
  command?: string
  /** Exit code for shell commands. */
  exitCode?: number
  /** Input token count for the activity. */
  tokensIn?: number
  /** Output token count for the activity. */
  tokensOut?: number
  /** Cost in dollars for the activity. */
  cost?: number
  /** Unix millisecond timestamp of the event. */
  timestamp: number
}

/** Options for constructing an {@link ActivityBuffer}. */
export interface ActivityBufferOptions {
  /** Maximum number of entries retained per session (default 100). */
  maxPerSession?: number
}

/**
 * In-memory rolling buffer of per-session activity events.
 *
 * Captures tool calls, shell commands, and step transitions for the dashboard
 * verbose view. Entries are capped at `maxPerSession` per session — when the
 * limit is exceeded the oldest entries are evicted.
 */
export class ActivityBuffer {
  private readonly buffers: Map<string, ActivityEntry[]> = new Map()
  private readonly maxPerSession: number

  /**
   * @param options Optional configuration. `maxPerSession` defaults to 100.
   */
  constructor(options?: ActivityBufferOptions) {
    this.maxPerSession = options?.maxPerSession ?? 100
  }

  /**
   * Add an activity entry to the session's buffer.
   * When the buffer exceeds `maxPerSession`, the oldest entries are dropped.
   * @param sessionID The session to record activity for.
   * @param entry The activity event to store.
   */
  record(sessionID: string, entry: ActivityEntry): void {
    const entries = this.buffers.get(sessionID) ?? []
    entries.push(entry)
    if (entries.length > this.maxPerSession) {
      entries.splice(0, entries.length - this.maxPerSession)
    }
    this.buffers.set(sessionID, entries)
  }

  /**
   * Retrieve activity entries for a session in chronological order (oldest first).
   * @param sessionID The session to query.
   * @param limit If provided, return only the N most recent entries.
   * @returns Array of entries (empty if session has no recorded activity).
   */
  getActivity(sessionID: string, limit?: number): ActivityEntry[] {
    const entries = this.buffers.get(sessionID)
    if (!entries) return []
    if (limit !== undefined) return entries.slice(-limit)
    return [...entries]
  }

  /**
   * Remove all entries for a session.
   * @param sessionID The session to clear.
   */
  remove(sessionID: string): void {
    this.buffers.delete(sessionID)
  }

  /**
   * Check whether any entries exist for a session.
   * @param sessionID The session to check.
   * @returns `true` if at least one entry exists, `false` otherwise.
   */
  has(sessionID: string): boolean {
    const entries = this.buffers.get(sessionID)
    return entries !== undefined && entries.length > 0
  }
}
