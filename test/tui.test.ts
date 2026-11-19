import { describe, expect, test } from "bun:test"
import {
  TextAttributes,
  isTextNodeRenderable,
  type RGBA,
  type Renderable,
  type TextRenderable,
  type TextNodeRenderable,
} from "@opentui/core"
import { type JSX, testRender } from "@opentui/solid"
import tui from "../src/tui"

type TuiContext = Parameters<typeof tui.setup>[0]
type TeamContextData = {
  team: string | null
  members: Array<{ name: string; status: string }>
  tasks: { pending: number; done: number }
}
type SlotPanel = { sessionID: string }
type SlotClaim = {
  append: string
  render: (panel: SlotPanel) => JSX.Element
}
type Registration = { claim: SlotClaim; disposed: boolean }
type ContextReader = (sessionID: string) => Promise<TeamContextData>
type RendererSetup = Awaited<ReturnType<typeof testRender>>
const browserSolidRuntime = import.meta.resolve("solid-js").endsWith("/dist/solid.js")

function colorBuffer(color: RGBA | undefined): number[] {
  if (!color) throw new Error("Expected a rendered foreground color")
  return color.toInts()
}

function findSpan(
  spans: Array<{ text: string; fg: RGBA; attributes: number }>,
  text: string,
) {
  const span = spans.find((candidate) => candidate.text === text)
  if (!span) throw new Error(`Expected a rendered span with text "${text}"`)
  return span
}

function findLink(renderable: Renderable): TextNodeRenderable | undefined {
  if (isTextNodeRenderable(renderable) && renderable.link) return renderable
  const children =
    "getTextChildren" in renderable
      ? (renderable as TextRenderable).getTextChildren()
      : renderable.getChildren()
  return children
    .map((child) => findLink(child as Renderable))
    .find((child) => child !== undefined)
}

function createHarness(readContext: ContextReader) {
  const registrations: Registration[] = []
  const eventHandlers = new Map<string, Array<() => void>>()
  const rendererHandlers = new Map<string, Set<() => void>>()
  const unsubscribedEvents: string[] = []

  const renderer = {
    on: (name: string, handler: () => void) => {
      const handlers = rendererHandlers.get(name) ?? new Set()
      handlers.add(handler)
      rendererHandlers.set(name, handlers)
    },
    off: (name: string, handler: () => void) => {
      rendererHandlers.get(name)?.delete(handler)
    },
    emit: (name: string) => {
      rendererHandlers.get(name)?.forEach((handler) => {
        handler()
      })
    },
    listenerCount: (name: string) => rendererHandlers.get(name)?.size ?? 0,
  }

  const rpc = {
    teamContext: ({ sessionID }: { sessionID: string }) =>
      readContext(sessionID),
    events: {
      on: (name: string, handler: () => void) => {
        const handlers = eventHandlers.get(name) ?? []
        handlers.push(handler)
        eventHandlers.set(name, handlers)
        return () => unsubscribedEvents.push(name)
      },
    },
  }
  const context = {
    client: { rpc: () => rpc },
    location: { directory: "/project" },
    data: { location: { default: () => ({ directory: "/project" }) } },
    theme: {
      hue: { interactive: { 200: "#4488ff" } },
      text: {
        base: "#ffffff",
        muted: "#888888",
        action: { primary: { base: "#ffffff" } },
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
    renderer,
  } as unknown as TuiContext
  const cleanup = tui.setup(context) as () => void
  const roots = new Set<RendererSetup>()

  return {
    registrations,
    renderer,
    unsubscribedEvents,
    emitMember: () =>
      eventHandlers.get("member")?.forEach((handler) => {
        handler()
      }),
    render: async (index: number, sessionID = "lead-session") => {
      const registration = registrations[index]
      if (!registration) {
        throw new Error(`Sidebar registration ${index} is missing`)
      }
      const root = await testRender(
        () => registration.claim.render({ sessionID }),
        { width: 80, height: 20 },
      )
      roots.add(root)
      return root
    },
    release: (root: RendererSetup) => {
      root.renderer.destroy()
      roots.delete(root)
    },
    dispose: () => {
      roots.forEach((root) => {
        root.renderer.destroy()
      })
      cleanup()
    },
  }
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function member(status: string, name = status): TeamContextData["members"][number] {
  return { name, status }
}

describe("tui companion (issue #36)", () => {
  test("default export carries the companion id and setup", () => {
    const plugin = tui as unknown as { id?: unknown; setup?: unknown }
    expect(plugin.id).toBe("ensemble.tui")
    expect(typeof plugin.setup).toBe("function")
  })

  test("refreshes changed snapshots but does not replace the slot for identical data", async () => {
    let response: TeamContextData = {
      team: "alpha",
      members: [member("busy", "worker")],
      tasks: { pending: 1, done: 2 },
    }
    let calls = 0
    const harness = createHarness(async () => {
      calls += 1
      return structuredClone(response)
    })
    try {
      const initial = await harness.render(0)
      await initial.flush()
      expect(initial.captureCharFrame()).toContain("no active team")
      await nextTurn()

      expect(calls).toBe(1)
      expect(harness.registrations).toHaveLength(2)
      expect(harness.registrations[0]?.disposed).toBe(true)

      harness.release(initial)
      const current = await harness.render(1)
      harness.emitMember()
      await nextTurn()
      expect(calls).toBe(2)
      expect(harness.registrations).toHaveLength(2)

      response = {
        team: "alpha",
        members: [member("ready", "worker")],
        tasks: { pending: 0, done: 3 },
      }
      harness.emitMember()
      await nextTurn()
      expect(calls).toBe(3)
      expect(harness.registrations).toHaveLength(3)
      expect(harness.registrations[1]?.disposed).toBe(true)

      harness.release(current)
      const changed = await harness.render(2)
      await changed.flush()
      const frame = changed.captureCharFrame()
      expect(frame).toContain("worker")
      expect(frame).toContain("idle")
      expect(frame).toContain("3/3")
    } finally {
      harness.dispose()
    }
  })

  test("shows an RPC error and recovers on the next member event", async () => {
    let failed = false
    const harness = createHarness(async () => {
      if (failed) throw new Error("RPC unavailable")
      return {
        team: "alpha",
        members: [member("busy", "worker")],
        tasks: { pending: 1, done: 2 },
      }
    })
    try {
      const initial = await harness.render(0)
      await nextTurn()
      expect(harness.registrations).toHaveLength(2)
      harness.release(initial)

      failed = true
      const current = await harness.render(1)
      harness.emitMember()
      await nextTurn()
      expect(harness.registrations).toHaveLength(3)
      harness.release(current)

      const unavailable = await harness.render(2)
      await unavailable.flush()
      expect(unavailable.captureCharFrame()).toContain("Team status unavailable")

      failed = false
      harness.emitMember()
      await nextTurn()
      expect(harness.registrations).toHaveLength(4)
      harness.release(unavailable)

      const recovered = await harness.render(3)
      await recovered.flush()
      expect(recovered.captureCharFrame()).toContain("alpha")
      expect(recovered.captureCharFrame()).not.toContain("Team status unavailable")
    } finally {
      harness.dispose()
    }
  })

  test("queues a member refresh that arrives while an RPC is in flight", async () => {
    let resolveFirst: ((value: TeamContextData) => void) | undefined
    let calls = 0
    const harness = createHarness(
      () =>
        new Promise<TeamContextData>((resolve) => {
          calls += 1
          if (calls === 1) resolveFirst = resolve
          else {
            resolve({
              team: "alpha",
              members: [member("ready", "worker")],
              tasks: { pending: 0, done: 1 },
            })
          }
        }),
    )
    try {
      const initial = await harness.render(0)
      expect(calls).toBe(1)
      harness.emitMember()
      resolveFirst?.({
        team: "alpha",
        members: [member("busy", "worker")],
        tasks: { pending: 1, done: 0 },
      })
      await nextTurn()

      expect(calls).toBe(2)
      expect(harness.registrations).toHaveLength(3)
      harness.release(initial)

      const latest = await harness.render(2)
      await latest.flush()
      expect(latest.captureCharFrame()).toContain("idle")
      expect(latest.captureCharFrame()).toContain("1/1")
    } finally {
      harness.dispose()
    }
  })

  test("renders muted labels, status colors, team link, and progress segments", async () => {
    const harness = createHarness(async () => ({
      team: "alpha",
      members: [
        member("busy", "busy-agent"),
        member("ready", "ready-agent"),
        member("shutdown_requested", "stopping-agent"),
        member("shutdown", "done-agent"),
        member("error", "error-agent"),
      ],
      tasks: { pending: 1, done: 2 },
    }))
    try {
      const initial = await harness.render(0)
      await nextTurn()
      harness.release(initial)

      const current = await harness.render(1)
      await current.flush()

      const capture = current.captureSpans()
      const frame = current.captureCharFrame().split("\n")
      const header = capture.lines[0]?.spans ?? []
      expect(header.find((span) => span.text === "Ensemble")?.attributes).toBe(
        TextAttributes.BOLD,
      )
      expect(colorBuffer(findSpan(header, "alpha").fg)).toEqual([
        136, 136, 136, 255,
      ])
      expect(frame[0]?.trimEnd().endsWith("alpha")).toBe(true)

      const rows = capture.lines.map((line) => line.spans)
      const rowFor = (label: string) =>
        rows.find((spans) => spans.some((span) => span.text.trim() === label))
      const expectations = [
        ["working", [68, 136, 255, 255]],
        ["idle", [68, 187, 102, 255]],
        ["stopping", [255, 170, 51, 255]],
        ["done", [136, 136, 136, 255]],
        ["error", [238, 68, 68, 255]],
      ] as const
      expectations.forEach(([label, expectedColor]) => {
        const spans = rowFor(label)
        expect(spans).toBeDefined()
        const rowSpans = spans ?? []
        const icon = rowSpans.find((span) => span.text.trim() === "●")
        const labelSpan = rowSpans.find((span) => span.text.trim() === label)
        expect(colorBuffer(icon?.fg))
          .toEqual([...expectedColor])
        expect(colorBuffer(labelSpan?.fg))
          .toEqual([136, 136, 136, 255])
        const line = frame.find((value) => value.includes(label))?.trimEnd()
        expect(line?.endsWith(label)).toBe(true)
      })

      const link = findLink(current.renderer.root)
      expect(link?.link?.url).toBe("http://localhost:4747/")
      const taskRow = rows.find((spans) =>
        spans.some((span) => span.text.includes("2/3")),
      )
      expect(taskRow?.some((span) => span.text.includes("━"))).toBe(true)
      expect(frame.find((line) => line.includes("2/3"))?.trimEnd().endsWith("2/3"))
        .toBe(true)
    } finally {
      harness.dispose()
    }
  })

  test("renders empty and fully complete task bars at their endpoints", async () => {
    const assertTaskCase = async (
      tasks: TeamContextData["tasks"],
      count: string,
      completed: boolean,
    ) => {
      const harness = createHarness(async () => ({
        team: "alpha",
        members: [],
        tasks,
      }))
      try {
        const initial = await harness.render(0)
        await nextTurn()
        harness.release(initial)
        const current = await harness.render(1)
        await current.flush()
        const spans = current.captureSpans().lines.find((row) =>
          row.spans.some((span) => span.text.includes(count)),
        )?.spans
        expect(spans?.some((span) => span.text.includes("━"))).toBe(completed)
        expect(current.captureCharFrame()).toContain(count)
        harness.release(current)
      } finally {
        harness.dispose()
      }
    }

    await assertTaskCase({ pending: 0, done: 0 }, "0/0", false)
    await assertTaskCase({ pending: 0, done: 3 }, "3/3", true)
  })

  // `bun test` uses Solid's server entry; CI also runs this under browser conditions.
  test.skipIf(!browserSolidRuntime)(
    "underlines the team link only while hovered and fills the measured progress track",
    async () => {
      const harness = createHarness(async () => ({
        team: "alpha",
        members: [member("busy", "worker")],
        tasks: { pending: 1, done: 2 },
      }))
      try {
        const initial = await harness.render(0)
        await nextTurn()
        harness.release(initial)

        const measured = await harness.render(1)
        await measured.flush()
        expect(harness.renderer.listenerCount("frame")).toBeGreaterThan(0)

        const line = measured.captureCharFrame().split("\n")[0] ?? ""
        const teamColumn = line.indexOf("alpha")
        expect(teamColumn).toBeGreaterThanOrEqual(0)
        const linkBefore = findLink(measured.renderer.root)
        expect(linkBefore?.attributes).toBe(TextAttributes.NONE)

        await measured.mockMouse.moveTo(teamColumn, 0)
        expect(findLink(measured.renderer.root)?.attributes).toBe(
          TextAttributes.UNDERLINE,
        )
        await measured.mockMouse.moveTo(0, 10)
        expect(findLink(measured.renderer.root)?.attributes).toBe(
          TextAttributes.NONE,
        )

        harness.renderer.emit("frame")
        expect(harness.registrations).toHaveLength(3)
        harness.release(measured)

        const fullBar = await harness.render(2)
        await fullBar.flush()
        const taskSpans = fullBar.captureSpans().lines.find((row) =>
          row.spans.some((span) => span.text.includes("2/3")),
        )?.spans
        const completed = taskSpans?.find((span) => span.text.includes("━"))
        const remaining = taskSpans?.find((span) => span.text.includes("─"))
        expect(completed?.text.length).toBeGreaterThan(1)
        expect(remaining?.text.length).toBeGreaterThan(1)
        const taskLine =
          fullBar.captureCharFrame().split("\n").find((value) => value.includes("2/3")) ??
          ""
        const availableTrackWidth =
          taskLine.indexOf("2/3") -
          taskLine.indexOf("tasks ") -
          "tasks ".length -
          1
        const renderedTrackWidth =
          (completed?.text.match(/━/g)?.length ?? 0) +
          (remaining?.text.match(/─/g)?.length ?? 0)
        expect(availableTrackWidth).toBe(renderedTrackWidth)

        harness.release(fullBar)
        expect(harness.renderer.listenerCount("frame")).toBe(0)
      } finally {
        harness.dispose()
      }
    },
  )

  test("disposes the active slot and RPC event subscriptions", () => {
    const harness = createHarness(async () => ({
      team: null,
      members: [],
      tasks: { pending: 0, done: 0 },
    }))
    harness.dispose()
    expect(harness.registrations[0]?.disposed).toBe(true)
    expect(harness.unsubscribedEvents).toContain("member")
    expect(harness.unsubscribedEvents).toContain("view")
  })
})
