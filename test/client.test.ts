import { describe, test, expect } from "bun:test"
import { wrapThrowingClient } from "../src/client"
import type { PluginClient } from "../src/types"

/** Fake SDK client that returns HeyAPI-style { data } or { error } responses. */
function fakeSDK(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      create: overrides["session.create"] ?? (async () => ({ data: { id: "sess-1" } })),
      promptAsync: overrides["session.promptAsync"] ?? (async () => ({ data: {} })),
      abort: overrides["session.abort"] ?? (async () => ({ data: {} })),
      status: overrides["session.status"] ?? (async () => ({ data: {} })),
    },
    tui: {
      showToast: overrides["tui.showToast"] ?? (async () => ({ data: {} })),
      selectSession: overrides["tui.selectSession"] ?? (async () => ({ data: {} })),
    },
    worktree: {
      create: overrides["worktree.create"] ?? (async () => ({ data: { name: "wt", branch: "b", directory: "/tmp/wt" } })),
      remove: overrides["worktree.remove"] ?? (async () => ({ data: {} })),
      list: overrides["worktree.list"] ?? (async () => ({ data: [] })),
      reset: overrides["worktree.reset"] ?? (async () => ({ data: {} })),
    },
  }
}

describe("wrapThrowingClient", () => {
  test("passes through data on success", async () => {
    const client = wrapThrowingClient(fakeSDK())
    const result = await client.session.create({ title: "test" })
    expect(result.data?.id).toBe("sess-1")
  })

  test("throws when SDK returns error response", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "session.create": async () => ({ error: { message: "bad request" } }),
    }))
    await expect(client.session.create({ title: "test" })).rejects.toThrow("bad request")
  })

  test("throws with stringified error when error is not an object", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "session.create": async () => ({ error: "something went wrong" }),
    }))
    await expect(client.session.create({ title: "test" })).rejects.toThrow("something went wrong")
  })

  test("wraps all session methods", async () => {
    const client = wrapThrowingClient(fakeSDK())
    expect(typeof client.session.create).toBe("function")
    expect(typeof client.session.promptAsync).toBe("function")
    expect(typeof client.session.abort).toBe("function")
    expect(typeof client.session.status).toBe("function")
  })

  test("wraps all worktree methods", async () => {
    const client = wrapThrowingClient(fakeSDK())
    expect(typeof client.worktree.create).toBe("function")
    expect(typeof client.worktree.remove).toBe("function")
    expect(typeof client.worktree.list).toBe("function")
    expect(typeof client.worktree.reset).toBe("function")
  })

  test("worktree error throws", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "worktree.create": async () => ({ error: { message: "no space" } }),
    }))
    await expect(client.worktree.create({ worktreeCreateInput: { name: "x" } })).rejects.toThrow("no space")
  })
})
