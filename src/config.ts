import { readFileSync } from "node:fs"
import path from "node:path"

/** Plugin configuration shape. All fields optional — defaults applied. */
export interface EnsembleConfig {
  /** Auto-merge worktree branches on cleanup (default: true) */
  mergeOnCleanup?: boolean
  /** Stall detection threshold in ms (default: 180000 = 3 min, 0 to disable) */
  stallThresholdMs?: number
  /** Min steps before token-based stall check (default: 3) */
  stallMinSteps?: number
  /** Output token threshold for stall detection (default: 500) */
  stallTokenThreshold?: number
  /** Hard timeout for busy members in ms (default: 1800000 = 30 min, 0 to disable) */
  timeoutMs?: number
  /** Rate limit capacity (default: 10, 0 to disable) */
  rateLimitCapacity?: number
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Required<EnsembleConfig> = {
  mergeOnCleanup: true,
  stallThresholdMs: 180_000,
  stallMinSteps: 3,
  stallTokenThreshold: 500,
  timeoutMs: 30 * 60 * 1000,
  rateLimitCapacity: 10,
}

/** Read a JSON config file, returning an empty object on missing/invalid. */
function readConfigFile(filePath: string): Partial<EnsembleConfig> {
  try {
    const text = readFileSync(filePath, "utf-8")
    const raw = JSON.parse(text) as Record<string, unknown>
    // Validate types — only accept numbers for numeric fields, booleans for boolean fields
    const result: Partial<EnsembleConfig> = {}
    if (typeof raw.mergeOnCleanup === "boolean") result.mergeOnCleanup = raw.mergeOnCleanup
    if (typeof raw.stallThresholdMs === "number") result.stallThresholdMs = raw.stallThresholdMs
    if (typeof raw.stallMinSteps === "number") result.stallMinSteps = raw.stallMinSteps
    if (typeof raw.stallTokenThreshold === "number") result.stallTokenThreshold = raw.stallTokenThreshold
    if (typeof raw.timeoutMs === "number") result.timeoutMs = raw.timeoutMs
    if (typeof raw.rateLimitCapacity === "number") result.rateLimitCapacity = raw.rateLimitCapacity
    return result
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
    console.warn(`[ensemble] Invalid config at ${filePath}, using defaults`)
    return {}
  }
}

/**
 * Load plugin configuration. Merges global → project → env vars.
 * Missing files are silently skipped. Invalid JSON logs a warning.
 */
export function loadConfig(projectDir: string): Required<EnsembleConfig> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const globalPath = path.join(homeDir, ".config", "opencode", "ensemble.json")
  const projectPath = path.join(projectDir, ".opencode", "ensemble.json")

  const global = readConfigFile(globalPath)
  const project = readConfigFile(projectPath)
  const merged = { ...DEFAULT_CONFIG, ...global, ...project }

  // Env vars override everything
  const timeout = process.env.OPENCODE_ENSEMBLE_TIMEOUT
  if (timeout !== undefined) merged.timeoutMs = timeout === "0" ? 0 : (parseInt(timeout, 10) || merged.timeoutMs)

  const rateLimit = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  if (rateLimit !== undefined) merged.rateLimitCapacity = rateLimit === "0" ? 0 : (parseInt(rateLimit, 10) || merged.rateLimitCapacity)

  const stall = process.env.STALL_THRESHOLD_MS
  if (stall !== undefined) merged.stallThresholdMs = stall === "0" ? 0 : (parseInt(stall, 10) || merged.stallThresholdMs)

  return merged
}
