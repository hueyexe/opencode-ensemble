import { describe, expect, test } from "bun:test"
import { fetchTeamContext, type TeamContextData } from "../src/tui-context"

const team: TeamContextData = { team: "test-team", members: [], tasks: { pending: 2, done: 1 } }

function source(directory?: string) {
  return {
    location: directory ? { directory } : undefined,
    data: {
      session: { get: () => undefined },
      location: { default: () => ({ directory: "/client-default" }) },
    },
  }
}

describe("TUI location-scoped team context", () => {
  test("routes the request to the displayed session's location before the companion location", async () => {
    const context = source("/other-project")
    const sessionLocation = { directory: "/session-project", workspaceID: "ws-test" }
    const sessionContext = {
      ...context,
      data: { ...context.data, session: { get: () => ({ location: sessionLocation }) } },
    } as unknown as Parameters<typeof fetchTeamContext>[0]
    const result = await fetchTeamContext(sessionContext, {
      teamContext: async (input, options) => {
        expect(input).toEqual({ sessionID: "ses-test" })
        expect(options?.location).toEqual(sessionLocation)
        return team
      },
    }, "ses-test")
    expect(result).toEqual(team)
  })

  test("uses the companion location when session data is not cached", async () => {
    const result = await fetchTeamContext(source("/project"), {
      teamContext: async (_input, options) => {
        expect(options?.location).toEqual({ directory: "/project" })
        return team
      },
    }, "ses-test")
    expect(result).toEqual(team)
  })

  test("uses the client's current default if no session or companion location is available", async () => {
    const result = await fetchTeamContext(source(), {
      teamContext: async (_input, options) => {
        expect(options?.location).toEqual({ directory: "/client-default" })
        return team
      },
    }, "ses-test")
    expect(result).toEqual(team)
  })

  test("does not query RPC without a displayed session", async () => {
    const result = await fetchTeamContext(source(), {
      teamContext: async () => { throw new Error("RPC must not be called") },
    })
    expect(result).toBeNull()
  })

  test("preserves a successful response for a session without an active team", async () => {
    const empty: TeamContextData = { team: null, members: [], tasks: { pending: 0, done: 0 } }
    expect(await fetchTeamContext(source("/project"), {
      teamContext: async () => empty,
    }, "ses-other")).toEqual(empty)
  })

  test("propagates RPC failure rather than reporting that there is no team", async () => {
    await expect(fetchTeamContext(source("/project"), {
      teamContext: async () => { throw new Error("rpc.unavailable") },
    }, "ses-test")).rejects.toThrow("rpc.unavailable")
  })
})
