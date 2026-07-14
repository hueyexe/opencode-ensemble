import type { MemberRegistry } from "./state"

/**
 * A single activity event captured per session for the dashboard verbose view.
 */
export interface ActivityEntry {
  /** The kind of activity being recorded. */
  type: "tool_call" | "tool_result" | "shell_command" | "step" | "reasoning" | "file" | "text"
  /** Tool name (for tool_call / tool_result types). */
  tool?: string
  /** Human-readable title for the activity. */
  title?: string
  /** Structured input for a tool call (JSON-formatted string if object). */
  input?: string
  /** Structured output for a tool result (JSON-formatted string if object). */
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
  /** Reasoning text (for reasoning type — model's chain of thought). */
  reasoning?: string
  /** File path (for file type). */
  filePath?: string
  /** File content (for file type). */
  fileContent?: string
  /** File diff (for file type). */
  fileDiff?: string
  /** Text content (for text type — prompts and responses). */
  text?: string
  /** Role for text entries: "user" or "assistant". */
  role?: string
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

/** V2 event shape for activity recording (permissive — SDK types not available in plugin). */
interface V2Event {
  type: string
  properties: {
    sessionID?: string
    tool?: string
    input?: string
    content?: string
    title?: string
    error?: string
    command?: string
    exitCode?: number
    cost?: number
    tokens?: { input?: number; output?: number }
  }
}

/**
 * Record activity from a v2 session event (shell commands and step transitions only).
 * Tool call/result recording is handled by {@link recordFromToolBefore} and {@link recordFromToolAfter}
 * to avoid duplicate entries from both the event hook and the tool.execute hook.
 * Only records for sessions registered as team members.
 * @param event The v2 event from the plugin event hook.
 * @param registry The member registry for session lookup.
 * @param buffer The activity buffer to record into.
 */
export function recordFromV2Event(
  event: V2Event,
  registry: MemberRegistry,
  buffer: ActivityBuffer,
): void {
  const props = event.properties
  if (!props?.sessionID || !registry.getBySession(props.sessionID)) return

  if (event.type === "session.next.shell.started") {
    buffer.record(props.sessionID, { type: "shell_command", command: props.command, timestamp: Date.now() })
  } else if (event.type === "session.next.shell.ended") {
    buffer.record(props.sessionID, { type: "shell_command", exitCode: props.exitCode, timestamp: Date.now() })
  } else if (event.type === "session.next.step.ended") {
    buffer.record(props.sessionID, {
      type: "step",
      cost: props.cost,
      tokensIn: props.tokens?.input,
      tokensOut: props.tokens?.output,
      timestamp: Date.now(),
    })
  }
}

/** Input shape for the tool.execute.before hook. */
interface ToolBeforeInput {
  sessionID: string
  tool: string
}

/** Output shape for the tool.execute.after hook. */
interface ToolAfterOutput {
  title?: string
  output?: string
}

/**
 * Record a tool call from the tool.execute.before hook.
 * Only records for sessions registered as team members.
 * @param input The tool.execute.before input.
 * @param registry The member registry for session lookup.
 * @param buffer The activity buffer to record into.
 */
export function recordFromToolBefore(
  input: ToolBeforeInput,
  registry: MemberRegistry,
  buffer: ActivityBuffer,
): void {
  if (!registry.getBySession(input.sessionID)) return
  buffer.record(input.sessionID, { type: "tool_call", tool: input.tool, timestamp: Date.now() })
}

/**
 * Record a tool result from the tool.execute.after hook.
 * Only records for sessions registered as team members.
 * @param input The tool.execute.before input (for session ID and tool name).
 * @param output The tool.execute.after output.
 * @param registry The member registry for session lookup.
 * @param buffer The activity buffer to record into.
 */
export function recordFromToolAfter(
  input: ToolBeforeInput,
  output: ToolAfterOutput,
  registry: MemberRegistry,
  buffer: ActivityBuffer,
): void {
  if (!registry.getBySession(input.sessionID)) return
  buffer.record(input.sessionID, {
    type: "tool_result",
    tool: input.tool,
    title: output.title,
    output: output.output,
    timestamp: Date.now(),
  })
}
