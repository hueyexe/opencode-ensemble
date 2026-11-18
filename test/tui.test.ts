import { describe, expect, test } from "bun:test"
import { type JSX, testRender } from "@opentui/solid"
import tui from "../src/tui"

type TuiContext = Parameters<typeof tui.setup>[0]
type SlotPanel = { sessionID: string }
type SlotClaim = {
  append: string
  render: (panel: SlotPanel) => JSX.Element
}

describe("tui companion (issue #36)", () => {
  test("default export carries the companion id and setup", () => {
    const plugin = tui as unknown as { id?: unknown; setup?: unknown }
    expect(plugin.id).toBe("ensemble.tui")
    expect(typeof plugin.setup).toBe("function")
  })

  test("re-registers the sidebar after its team context resolves", async () => {
    const registrations: Array<{ claim: SlotClaim; disposed: boolean }> = []
    let contextCalls = 0
    let failContext = false
    let onMember: (() => void) | undefined
    const rpc = {
      teamContext: async () => {
        contextCalls += 1
        if (failContext) throw new Error("RPC unavailable")
        return {
          team: "alpha",
          members: [{ name: "worker", status: "busy" }],
          tasks: { pending: 1, done: 2 },
        }
      },
      events: {
        on: (name: string, handler: () => void) => {
          if (name === "member") onMember = handler
          return () => {}
        },
      },
    }
    const context = {
      client: { rpc: () => rpc },
      location: { directory: "/project" },
      data: { location: { default: () => ({ directory: "/project" }) } },
      theme: {
        text: {
          base: "#ffffff",
          muted: "#888888",
          action: { primary: { base: "#4488ff" } },
          feedback: {
            success: { base: "#44bb66" },
            warning: { base: "#ffaa33" },
            error: { base: "#ee4444" },
          },
        },
      },
      ui: {
        slot: (claim: SlotClaim) => {
          const registration = { claim, disposed: false }
          registrations.push(registration)
          return () => {
            registration.disposed = true
          }
        },
      },
      renderer: { on: () => {}, off: () => {} },
    } as unknown as TuiContext

    const dispose = tui.setup(context) as () => void
    expect(registrations).toHaveLength(1)

    const firstRegistration = registrations[0]
    if (!firstRegistration) throw new Error("Sidebar slot was not registered")
    const initial = await testRender(
      () => firstRegistration.claim.render({ sessionID: "lead-session" }),
      { width: 80, height: 20 },
    )
    let updated: Awaited<ReturnType<typeof testRender>> | undefined
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(contextCalls).toBeGreaterThan(0)
      expect(registrations).toHaveLength(2)
      expect(firstRegistration.disposed).toBe(true)

      const updatedRegistration = registrations[1]
      if (!updatedRegistration) throw new Error("Updated sidebar was not registered")
      updated = await testRender(
        () => updatedRegistration.claim.render({ sessionID: "lead-session" }),
        { width: 80, height: 20 },
      )
      await updated.flush()
      const frame = updated.captureCharFrame()
      expect(frame).toContain("alpha")
      expect(frame).toContain("worker")
      expect(frame).toContain("2/3")

      failContext = true
      onMember?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(registrations).toHaveLength(3)
      const unavailableRegistration = registrations[2]
      if (!unavailableRegistration) {
        throw new Error("Unavailable sidebar was not registered")
      }
      updated.renderer.destroy()
      const unavailable = await testRender(
        () =>
          unavailableRegistration.claim.render({
            sessionID: "lead-session",
          }),
        { width: 80, height: 20 },
      )
      updated = unavailable
      await unavailable.flush()
      expect(unavailable.captureCharFrame()).toContain("Team status unavailable")
    } finally {
      initial.renderer.destroy()
      updated?.renderer.destroy()
      dispose()
    }
  })
})
