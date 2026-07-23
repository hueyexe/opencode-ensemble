import type { Database } from "./db"

/** A parsed provider/model pair, as accepted by session.promptAsync. */
export interface ParsedModel {
  providerID: string
  modelID: string
}

/**
 * Parse a "provider/model" string into { providerID, modelID } for the SDK.
 * Returns undefined if the string is not in "provider/model" form (empty
 * provider or empty model). The model portion may itself contain slashes.
 */
export function parseModelId(model: string): ParsedModel | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
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
