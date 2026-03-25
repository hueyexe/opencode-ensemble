import type { Database } from "bun:sqlite"
import type { PluginClient } from "./types"
import { generateId } from "./util"

const MAX_CONTENT_BYTES = 10 * 1024 // 10KB

/** Input for sending a direct message. */
export interface SendMessageInput {
  teamId: string
  from: string
  to: string
  content: string
}

/** Input for broadcasting a message. */
export interface BroadcastMessageInput {
  teamId: string
  from: string
  content: string
}

/** A message row from the database. */
export interface MessageRow {
  id: string
  team_id: string
  from_name: string
  to_name: string | null
  content: string
  delivered: number
  time_created: number
}

/**
 * Insert a direct message into team_message. Returns the message ID.
 * Throws if content exceeds 10KB.
 */
export function sendMessage(db: Database, input: SendMessageInput): string {
  if (new TextEncoder().encode(input.content).length > MAX_CONTENT_BYTES) {
    throw new Error("Message content exceeds 10KB limit")
  }
  const id = generateId("msg")
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [id, input.teamId, input.from, input.to, input.content, Date.now()]
  )
  return id
}

/**
 * Insert a broadcast message (to_name = NULL) into team_message. Returns the message ID.
 * Throws if content exceeds 10KB.
 */
export function broadcastMessage(db: Database, input: BroadcastMessageInput): string {
  if (new TextEncoder().encode(input.content).length > MAX_CONTENT_BYTES) {
    throw new Error("Message content exceeds 10KB limit")
  }
  const id = generateId("msg")
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, NULL, ?, 0, ?)",
    [id, input.teamId, input.from, input.content, Date.now()]
  )
  return id
}

/**
 * Get all undelivered messages for a team.
 */
export function getUndeliveredMessages(db: Database, teamId: string): MessageRow[] {
  return db.query(
    "SELECT * FROM team_message WHERE team_id = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId) as MessageRow[]
}

/**
 * Mark a message as delivered.
 */
export function markDelivered(db: Database, messageId: string): void {
  db.run("UPDATE team_message SET delivered = 1 WHERE id = ?", [messageId])
}

/**
 * Flush undelivered messages addressed to the lead for a given team.
 * Batches all pending messages into a single promptAsync call to avoid
 * interrupting the lead with multiple deliveries. Returns count of delivered messages.
 */
export async function flushPendingMessages(
  db: Database,
  client: PluginClient,
  teamId: string,
  leadSessionId: string,
): Promise<number> {
  const pending = db.query(
    "SELECT * FROM team_message WHERE team_id = ? AND delivered = 0 AND to_name = 'lead' ORDER BY time_created ASC"
  ).all(teamId) as MessageRow[]

  if (pending.length === 0) return 0

  const MAX_LEAD_MSG = 500
  const parts = pending.map((msg) => {
    if (msg.content.length > MAX_LEAD_MSG) {
      return `[Team message from ${msg.from_name}]: ${msg.content.slice(0, MAX_LEAD_MSG)}... (use team_results to read full message)`
    }
    return `[Team message from ${msg.from_name}]: ${msg.content}`
  })

  try {
    await client.session.promptAsync({
      sessionID: leadSessionId,
      parts: [{ type: "text", text: parts.join("\n") }],
    })
    for (const msg of pending) markDelivered(db, msg.id)
    return pending.length
  } catch {
    return 0
  }
}
