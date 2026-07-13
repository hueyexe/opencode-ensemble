import { describe, test, expect } from "bun:test"
import { wrapThrowingClient } from "../src/client"
import { mockClient } from "./helpers"

/** Fake SDK client with extended session methods for wrapThrowingClient tests. */
function fakeSDK(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      create: overrides["session.create"] ?? (async () => ({ data: { id: "sess-1" } })),
      promptAsync: overrides["session.promptAsync"] ?? (async () => ({ data: {} })),
      abort: overrides["session.abort"] ?? (async () => ({ data: {} })),
      status: overrides["session.status"] ?? (async () => ({ data: {} })),
      messages: overrides["session.messages"] ?? (async () => ({ data: [] })),
      get: overrides["session.get"] ?? (async () => ({ data: {} })),
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
    experimental: {
      workspace: {
        create: overrides["workspace.create"] ?? (async () => ({ data: { id: "ws-1", type: "worktree", branch: null, directory: null, projectID: "proj-1" } })),
        remove: overrides["workspace.remove"] ?? (async () => ({ data: {} })),
        list: overrides["workspace.list"] ?? (async () => ({ data: [] })),
      },
    },
  }
}

describe("PluginClient extended session methods", () => {
  test("wrapThrowingClient exposes session.messages as a function", () => {
    const client = wrapThrowingClient(fakeSDK())
    expect(typeof client.session.messages).toBe("function")
  })

  test("wrapThrowingClient exposes session.get as a function", () => {
    const client = wrapThrowingClient(fakeSDK())
    expect(typeof client.session.get).toBe("function")
  })

  test("session.messages passes through data on success", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "session.messages": async () => ({ data: [{ info: {}, parts: [] }] }),
    }))
    const result = await client.session.messages({ sessionID: "sess-1" })
    expect(result.data).toEqual([{ info: {}, parts: [] }])
  })

  test("session.messages throws on error response", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "session.messages": async () => ({ error: { message: "session not found" } }),
    }))
    await expect(client.session.messages({ sessionID: "bad" })).rejects.toThrow("session not found")
  })

  test("session.get passes through data on success", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "session.get": async () => ({ data: { id: "sess-1", title: "test" } }),
    }))
    const result = await client.session.get({ sessionID: "sess-1" })
    expect(result.data).toEqual({ id: "sess-1", title: "test" })
  })

  test("session.get throws on error response", async () => {
    const client = wrapThrowingClient(fakeSDK({
      "session.get": async () => ({ error: { message: "not found" } }),
    }))
    await expect(client.session.get({ sessionID: "bad" })).rejects.toThrow("not found")
  })
})

describe("mockClient extended session methods", () => {
  test("mockClient exposes session.messages as a function", () => {
    const client = mockClient()
    expect(typeof client.session.messages).toBe("function")
  })

  test("mockClient exposes session.get as a function", () => {
    const client = mockClient()
    expect(typeof client.session.get).toBe("function")
  })

  test("mockClient session.messages returns { data: [] } by default", async () => {
    const client = mockClient()
    const result = await client.session.messages({ sessionID: "sess-1" })
    expect(result.data).toEqual([])
  })

  test("mockClient session.get returns { data: {} } by default", async () => {
    const client = mockClient()
    const result = await client.session.get({ sessionID: "sess-1" })
    expect(result.data).toEqual({})
  })

  test("mockClient session.messages records the call", async () => {
    const client = mockClient()
    await client.session.messages({ sessionID: "sess-1", limit: 10 })
    expect(client.calls).toContainEqual({ method: "session.messages", args: [{ sessionID: "sess-1", limit: 10 }] })
  })

  test("mockClient session.get records the call", async () => {
    const client = mockClient()
    await client.session.get({ sessionID: "sess-1" })
    expect(client.calls).toContainEqual({ method: "session.get", args: [{ sessionID: "sess-1" }] })
  })
})

