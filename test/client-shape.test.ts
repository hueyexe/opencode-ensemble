import { describe, test, expect } from "bun:test"
import { OpencodeClient as OpencodeClientV2 } from "@opencode-ai/sdk/v2"

/**
 * Smoke test: verify the v2 SDK client has every method our PluginClient interface expects.
 * Catches SDK renames/restructures that the wrapThrowingClient wrapper hides.
 */
describe("v2 SDK client shape matches PluginClient", () => {
  const client = new OpencodeClientV2()

  test("session methods exist", () => {
    expect(typeof client.session.create).toBe("function")
    expect(typeof client.session.promptAsync).toBe("function")
    expect(typeof client.session.abort).toBe("function")
    expect(typeof client.session.status).toBe("function")
  })

  test("tui methods exist", () => {
    expect(typeof client.tui.showToast).toBe("function")
    expect(typeof client.tui.selectSession).toBe("function")
  })

  test("worktree methods exist", () => {
    expect(typeof client.worktree.create).toBe("function")
    expect(typeof client.worktree.remove).toBe("function")
    expect(typeof client.worktree.list).toBe("function")
    expect(typeof client.worktree.reset).toBe("function")
  })

  test("experimental.workspace methods exist", () => {
    expect(typeof client.experimental.workspace.create).toBe("function")
    expect(typeof client.experimental.workspace.remove).toBe("function")
    expect(typeof client.experimental.workspace.list).toBe("function")
  })
})
