import { describe, expect, test } from "bun:test"
import path from "node:path"
import plugin from "../src/index"

const root = path.resolve(import.meta.dir, "..")

/** Mirror the local-directory lookup in the installed OpenCode Host.resolve. */
function resolveLocal(candidates: string[]): string | undefined {
  return candidates.reduce<string | undefined>((resolved, candidate) => {
    if (resolved) return resolved
    try {
      return Bun.resolveSync(path.join(root, candidate), root)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return undefined
      throw error
    }
  }, undefined)
}

describe("OpenCode local-directory entrypoints", () => {
  test("resolves the server with the host's root lookup and preserves the dual-host export", async () => {
    const entry = resolveLocal(["server", "index"])
    expect(entry).toBeDefined()
    if (!entry) return
    const loaded = await import(entry)
    expect(loaded.default).toBe(plugin)
    expect(loaded.default.id).toBe("ensemble")
  })

  test("resolves the TUI companion with the host's root lookup", () => {
    expect(resolveLocal(["tui"])).toBe(path.join(root, "tui.tsx"))
  })

  test("resolves the RPC contract with the host's root lookup", () => {
    expect(resolveLocal(["rpc"])).toBe(path.join(root, "rpc.ts"))
  })

  test("does not resolve nonexistent entrypoints", () => {
    expect(resolveLocal(["nonexistent-ensemble-entry"])).toBeUndefined()
  })
})
