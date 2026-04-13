import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadConfig, DEFAULT_CONFIG } from "../src/config"

describe("config", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ensemble-config-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.OPENCODE_ENSEMBLE_TIMEOUT
    delete process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
    delete process.env.STALL_THRESHOLD_MS
  })

  test("DEFAULT_CONFIG has correct values", () => {
    expect(DEFAULT_CONFIG.mergeOnCleanup).toBe(true)
    expect(DEFAULT_CONFIG.stallThresholdMs).toBe(300_000)
    expect(DEFAULT_CONFIG.stallMinSteps).toBe(5)
    expect(DEFAULT_CONFIG.stallTokenThreshold).toBe(200)
    expect(DEFAULT_CONFIG.timeoutMs).toBe(1_800_000)
    expect(DEFAULT_CONFIG.rateLimitCapacity).toBe(10)
  })

  test("returns defaults when no config files exist", () => {
    const config = loadConfig(tmpDir)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("project config overrides defaults", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ stallThresholdMs: 60_000 }))

    const config = loadConfig(tmpDir)
    expect(config.stallThresholdMs).toBe(60_000)
    expect(config.mergeOnCleanup).toBe(true) // other defaults preserved
  })

  test("partial config merges correctly", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ mergeOnCleanup: false, rateLimitCapacity: 5 }))

    const config = loadConfig(tmpDir)
    expect(config.mergeOnCleanup).toBe(false)
    expect(config.rateLimitCapacity).toBe(5)
    expect(config.stallThresholdMs).toBe(300_000) // default preserved
  })

  test("invalid JSON logs warning and returns defaults", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), "not json{{{")

    const config = loadConfig(tmpDir)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("env var OPENCODE_ENSEMBLE_TIMEOUT overrides config", () => {
    process.env.OPENCODE_ENSEMBLE_TIMEOUT = "60000"
    const config = loadConfig(tmpDir)
    expect(config.timeoutMs).toBe(60_000)
  })

  test("env var OPENCODE_ENSEMBLE_RATE_LIMIT overrides config", () => {
    process.env.OPENCODE_ENSEMBLE_RATE_LIMIT = "0"
    const config = loadConfig(tmpDir)
    expect(config.rateLimitCapacity).toBe(0)
  })

  test("env var STALL_THRESHOLD_MS overrides config", () => {
    process.env.STALL_THRESHOLD_MS = "0"
    const config = loadConfig(tmpDir)
    expect(config.stallThresholdMs).toBe(0)
  })

  test("env vars override file values", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({ timeoutMs: 999 }))
    process.env.OPENCODE_ENSEMBLE_TIMEOUT = "123"

    const config = loadConfig(tmpDir)
    expect(config.timeoutMs).toBe(123)
  })
})
