import type { Database } from "./db"
import type { PluginClient } from "./types"

/** A parsed provider/model pair, as accepted by session.promptAsync. */
export interface ParsedModel {
  providerID: string
  modelID: string
  variant?: string
}

/** A session's current agent and model selection. Either may be unknown. */
export interface SessionSelection {
  agent?: string
  model?: ParsedModel
}

/** Format a parsed model back into "provider/model" (with "#variant" when set). */
export function formatModelId(model: ParsedModel): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

/**
 * Parse a "provider/model" string into { providerID, modelID } for the SDK.
 * Returns undefined if the string is not in "provider/model" form (empty
 * provider or empty model). The model portion may itself contain slashes.
 * A trailing "#variant" selects a model variant, e.g. "openai/gpt-6.1-terra#max".
 */
export function parseModelId(model: string): ParsedModel | undefined {
  const hash = model.indexOf("#")
  const variant = hash === -1 ? undefined : model.slice(hash + 1) || undefined
  const base = hash === -1 ? model : model.slice(0, hash)
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  return {
    providerID: base.slice(0, slash),
    modelID: base.slice(slash + 1),
    ...(variant ? { variant } : {}),
  }
}

/**
 * Read a team member's stored model and parse it for session.promptAsync.
 * Returns undefined when the member is unknown, has no model set, or the
 * stored value is malformed. Never throws — safe to call from delivery paths.
 */
export function getMemberModel(db: Database, teamId: string, memberName: string): ParsedModel | undefined {
  const row = db.query("SELECT model FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { model: string | null } | null
  if (!row?.model) return undefined
  return parseModelId(row.model)
}

/** Text prefixes used by Ensemble-injected wake/delivery messages. */
const ENSEMBLE_MESSAGE_PREFIXES = [
  "[System:",
  "[System]",
  "[Team message from ",
  "[Recovered team message from ",
]

/** Whether every text part in a message is an Ensemble-injected notification. */
function isEnsembleInjected(parts: unknown[]): boolean {
  const textParts = parts.filter((part): part is { type: "text"; text: string } => {
    if (!part || typeof part !== "object") return false
    const candidate = part as { type?: unknown; text?: unknown }
    return candidate.type === "text" && typeof candidate.text === "string"
  })
  if (textParts.length === 0) return false
  return textParts.every(part => ENSEMBLE_MESSAGE_PREFIXES.some(prefix => part.text.startsWith(prefix)))
}

/** Accept both V1 ({ providerID, modelID }) and V2 ({ providerID, id }) model refs. */
function parseSessionModel(value: unknown): ParsedModel | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const providerID = typeof raw.providerID === "string" ? raw.providerID : undefined
  const modelID = typeof raw.modelID === "string"
    ? raw.modelID
    : typeof raw.id === "string"
      ? raw.id
      : undefined
  const variant = typeof raw.variant === "string" && raw.variant.length > 0 ? raw.variant : undefined
  if (!providerID || !modelID) return undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

/**
 * Best-effort lookup of a session's current agent and model selection.
 *
 * V2 exposes both directly on session.get. V1 does not, so it falls back to
 * the most recent real user message (skipping Ensemble's own wake messages,
 * which are injected as user turns on V1). Never throws: unknown selection
 * simply returns an empty object so delivery can proceed with defaults.
 */
export async function getSessionSelection(client: PluginClient, sessionID: string): Promise<SessionSelection> {
  let agent: string | undefined
  let model: ParsedModel | undefined

  // V2 fast path. `client.agent` is only present on the V2 adapter.
  if (client.agent) {
    try {
      const result = await client.session.get({ sessionID })
      const data = result.data as { agent?: unknown; model?: unknown } | undefined
      if (typeof data?.agent === "string") agent = data.agent
      model = parseSessionModel(data?.model)
    } catch {
      // Fall through to the message-based lookup.
    }
  }

  if (!agent || !model) {
    try {
      const result = await client.session.messages({ sessionID, limit: 100 })
      const messages = result.data ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message) continue
        const info = message.info as { role?: unknown; agent?: unknown; model?: unknown } | undefined
        if (info?.role !== "user") continue
        if (isEnsembleInjected(message.parts)) continue
        if (!agent && typeof info.agent === "string") agent = info.agent
        if (!model) model = parseSessionModel(info.model)
        if (agent && model) break
      }
    } catch {
      // Best effort only.
    }
  }

  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  }
}
