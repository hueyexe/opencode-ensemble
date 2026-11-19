/** @jsxImportSource @opentui/solid */
import "@opentui/solid"
import { RGBA, TextAttributes } from "@opentui/core"
import type {
  CliRenderer,
  TextNodeRenderable,
} from "@opentui/core"
import { onCleanup, onMount } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { EnsembleRpc } from "./rpc"
import {
  getLayoutWidth,
  isPrimaryLinkActivation,
  type LayoutMeasureNode,
} from "./tui-view"

const DASHBOARD_URL = "http://localhost:4747/"

/** Team context shape from the server bridge. */
interface TeamContextData {
  team: string | null
  members: Array<{ name: string; status: string }>
  tasks: { pending: number; done: number }
}

interface SidebarSnapshot {
  context: TeamContextData | null
  unavailable: boolean
}

type RpcClient = {
  teamContext(
    input: { sessionID: string },
    options?: { location?: unknown },
  ): Promise<TeamContextData>
  events: {
    on(name: "member", handler: () => void): () => void
  }
}

interface SidebarTheme {
  text: {
    muted: RGBA
    feedback: {
      success: { base: RGBA }
      warning: { base: RGBA }
      error: { base: RGBA }
    }
  }
}

/** Keep aligned with the dashboard's ST palette in dashboard-js-core.ts. */
const STATUS_COLORS = {
  busy: RGBA.fromHex("#60a5fa"),
  ready: RGBA.fromHex("#8a96aa"),
  shutdown_requested: RGBA.fromHex("#fbbf24"),
  shutdown: RGBA.fromHex("#7b879b"),
  error: RGBA.fromHex("#f87171"),
}

/** Open the Ensemble dashboard in the user's default browser. */
function openDashboard(): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open"
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", DASHBOARD_URL]
      : [DASHBOARD_URL]
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.on("error", (error) =>
    console.error("Unable to open Ensemble dashboard:", error),
  )
  child.unref()
}

function statusColor(status: string): RGBA {
  if (status in STATUS_COLORS) {
    return STATUS_COLORS[status as keyof typeof STATUS_COLORS]
  }
  return STATUS_COLORS.ready
}

function statusLabel(status: string): string {
  switch (status) {
    case "busy":
      return "working"
    case "ready":
      return "idle"
    case "shutdown_requested":
      return "stopping"
    case "shutdown":
      return "done"
    default:
      return status
  }
}

function sameSnapshot(
  left: SidebarSnapshot | undefined,
  right: SidebarSnapshot,
): boolean {
  if (!left || left.unavailable !== right.unavailable) return false
  if (left.unavailable || right.unavailable) return left.unavailable === right.unavailable
  const previous = left.context
  const next = right.context
  if (!previous || !next) return previous === next
  return (
    previous.team === next.team &&
    previous.tasks.done === next.tasks.done &&
    previous.tasks.pending === next.tasks.pending &&
    previous.members.length === next.members.length &&
    previous.members.every(
      (member, index) =>
        member.name === next.members[index]?.name &&
        member.status === next.members[index]?.status,
    )
  )
}

/** Render the sidebar from a snapshot, without async reactive dependencies. */
function TeamSidebar(props: {
  snapshot: SidebarSnapshot | undefined
  barWidth: number
  onBarWidthMeasured: (width: number) => void
  theme: SidebarTheme
  renderer: CliRenderer
}) {
  let sidebarBox: LayoutMeasureNode | undefined
  let teamLink: TextNodeRenderable | undefined
  const context = () => props.snapshot?.context
  const team = () => context()?.team
  const totalTasks = () => {
    const tasks = context()?.tasks
    return (tasks?.done ?? 0) + (tasks?.pending ?? 0)
  }
  const completedBars = () => {
    const total = totalTasks()
    if (total === 0) return 0
    return Math.min(
      props.barWidth,
      Math.round(((context()?.tasks.done ?? 0) / total) * props.barWidth),
    )
  }

  const measureBar = () => {
    const width = getLayoutWidth(sidebarBox)
    if (!width || !Number.isFinite(width)) return
    const labelWidth = "tasks ".length
    const countWidth = `${context()?.tasks.done ?? 0}/${totalTasks()}`.length
    const next = Math.max(1, Math.floor(width) - labelWidth - countWidth - 1)
    if (next !== props.barWidth) props.onBarWidthMeasured(next)
  }

  const setTeamLinkHover = (hovered: boolean) => {
    if (!teamLink) return
    teamLink.attributes = hovered
      ? TextAttributes.UNDERLINE
      : TextAttributes.NONE
  }

  onMount(() => {
    props.renderer.on("frame", measureBar)
    props.renderer.on("resize", measureBar)
    measureBar()
    onCleanup(() => {
      props.renderer.off("frame", measureBar)
      props.renderer.off("resize", measureBar)
    })
  })

  return (
    <box
      ref={(node) => (sidebarBox = node)}
      onSizeChange={measureBar}
      flexDirection="column"
      width="100%"
      flexGrow={1}
      minWidth={0}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        width="100%"
        alignItems="center"
      >
        <text attributes={TextAttributes.BOLD}>Ensemble</text>
        <text
          fg={props.theme.text.muted}
          onMouseUp={(event: { button: number; isDragging?: boolean }) => {
            if (team() && isPrimaryLinkActivation(event)) {
              openDashboard()
            }
          }}
          onMouseOver={() => setTeamLinkHover(true)}
          onMouseOut={() => setTeamLinkHover(false)}
          attributes={TextAttributes.NONE}
        >
          {props.snapshot?.unavailable
            ? "unavailable"
            : team()
              ? (
                  <a
                    ref={(node) => (teamLink = node)}
                    href={DASHBOARD_URL}
                  >
                    {team()}
                  </a>
                )
              : "no active team"}
        </text>
      </box>
      {(context()?.members ?? []).map((member) => (
        <box
          flexDirection="row"
          justifyContent="space-between"
          width="100%"
          alignItems="center"
        >
          <box flexDirection="row" alignItems="center">
            <text fg={statusColor(member.status)}>●</text>
            <text>{" "}{member.name}</text>
          </box>
          <text fg={props.theme.text.muted}>
            {statusLabel(member.status)}
          </text>
        </box>
      ))}
      {team() ? (
        <text
          width="100%"
          wrapMode="none"
        >
          <span style={{ fg: props.theme.text.muted }}>tasks </span>
          <span style={{ fg: props.theme.text.feedback.success.base }}>
            {"━".repeat(completedBars())}
          </span>
          <span style={{ fg: props.theme.text.muted }}>
            {"─".repeat(Math.max(0, props.barWidth - completedBars()))}
          </span>
          <span style={{ fg: props.theme.text.muted }}>
            {" "}
            {context()?.tasks.done ?? 0}/{totalTasks()}
          </span>
        </text>
      ) : null}
      {props.snapshot?.unavailable ? (
        <text fg={props.theme.text.feedback.error.base}>
          Team status unavailable
        </text>
      ) : null}
    </box>
  )
}

/**
 * Terminal companion for opencode-ensemble (issue #36).
 *
 * The sidebar shows live team status and task progress. team_view navigation
 * remains opt-in so teammates never take over the user's client unprompted.
 */
export default Plugin.define({
  id: "ensemble.tui",
  setup(context) {
    const rpc = context.client.rpc(EnsembleRpc)
    const location = context.location ?? context.data.location.default()
    const snapshots = new Map<string, SidebarSnapshot>()
    const barWidths = new Map<string, number>()
    const inFlight = new Set<string>()
    const queuedRefresh = new Set<string>()
    let activeSessionID: string | undefined
    let disposed = false
    let offSidebar: (() => void) | undefined

    async function refreshSession(sessionID: string) {
      if (disposed) return
      if (inFlight.has(sessionID)) {
        queuedRefresh.add(sessionID)
        return
      }
      inFlight.add(sessionID)
      let changed = false
      try {
        const result = (await rpc.teamContext(
          { sessionID },
          { location },
        )) as TeamContextData
        if (disposed) return
        const snapshot = { context: result, unavailable: false }
        changed = !sameSnapshot(snapshots.get(sessionID), snapshot)
        snapshots.set(sessionID, snapshot)
      } catch {
        if (disposed) return
        const snapshot = { context: null, unavailable: true }
        changed = !sameSnapshot(snapshots.get(sessionID), snapshot)
        snapshots.set(sessionID, snapshot)
      } finally {
        inFlight.delete(sessionID)
        if (changed && activeSessionID === sessionID && !disposed) {
          registerSidebar()
        }
        if (queuedRefresh.delete(sessionID)) void refreshSession(sessionID)
      }
    }

    function registerSidebar() {
      offSidebar?.()
      offSidebar = context.ui.slot({
        append: "sidebar.content",
        render: (panel: { sessionID: string }) => {
          activeSessionID = panel.sessionID
          if (
            panel.sessionID &&
            !snapshots.has(panel.sessionID) &&
            !inFlight.has(panel.sessionID)
          ) {
            void refreshSession(panel.sessionID)
          }
          return (
            <TeamSidebar
              snapshot={snapshots.get(panel.sessionID)}
              barWidth={barWidths.get(panel.sessionID) ?? 1}
              onBarWidthMeasured={(width) => {
                if ((barWidths.get(panel.sessionID) ?? 1) === width) return
                barWidths.set(panel.sessionID, width)
                if (activeSessionID === panel.sessionID && !disposed) {
                  registerSidebar()
                }
              }}
              theme={context.theme}
              renderer={context.renderer}
            />
          )
        },
      })
    }

    const refreshActiveSession = () => {
      const sessionID = activeSessionID
      if (!sessionID || disposed) return
      void refreshSession(sessionID)
    }

    const offView = rpc.events.on("view", (event) => {
      const data = event.data as unknown as { sessionID: string }
      if (!data.sessionID) return
      if (context.ui.tabs.enabled()) {
        void context.ui.tabs.focus(data.sessionID)
      } else {
        void context.ui.router.navigate({
          type: "session",
          sessionID: data.sessionID,
        })
      }
    })
    const offMember = rpc.events.on("member", refreshActiveSession)
    const timer = setInterval(refreshActiveSession, 10_000)
    registerSidebar()

    return () => {
      disposed = true
      clearInterval(timer)
      offView()
      offMember()
      offSidebar?.()
    }
  },
})
