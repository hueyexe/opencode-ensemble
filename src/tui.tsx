/** @jsxImportSource @opentui/solid */
import "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import type { BoxRenderable, CliRenderer, RGBA } from "@opentui/core"
import { createSignal, onCleanup, onMount } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { EnsembleRpc } from "./rpc"

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

function statusColor(status: string, theme: {
  text: {
    muted: RGBA
    action: { primary: { base: RGBA } }
    feedback: {
      success: { base: RGBA }
      warning: { base: RGBA }
      error: { base: RGBA }
    }
  }
}): RGBA {
  switch (status) {
    case "busy":
      return theme.text.action.primary.base
    case "ready":
      return theme.text.feedback.success.base
    case "shutdown_requested":
      return theme.text.feedback.warning.base
    case "error":
      return theme.text.feedback.error.base
    default:
      return theme.text.muted
  }
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
  theme: {
    text: {
      muted: RGBA
      action: { primary: { base: RGBA } }
      feedback: {
        success: { base: RGBA }
        warning: { base: RGBA }
        error: { base: RGBA }
      }
    }
  }
  renderer: CliRenderer
}) {
  const [teamHovered, setTeamHovered] = createSignal(false)
  const [barWidth, setBarWidth] = createSignal(1)
  let barTrack: BoxRenderable | undefined
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
      barWidth(),
      Math.round(((context()?.tasks.done ?? 0) / total) * barWidth()),
    )
  }

  const measureBar = () => {
    const width = barTrack?.getLayoutNode().getComputedWidth()
    if (!width || !Number.isFinite(width)) return
    const next = Math.max(1, Math.floor(width) - 1)
    if (next !== barWidth()) setBarWidth(next)
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
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
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
            if (team() && event.button === 0 && !event.isDragging) {
              openDashboard()
            }
          }}
          attributes={
            team() && teamHovered()
              ? TextAttributes.UNDERLINE
              : TextAttributes.NONE
          }
          onMouseOver={() => setTeamHovered(true)}
          onMouseOut={() => setTeamHovered(false)}
        >
          {props.snapshot?.unavailable
            ? "unavailable"
            : team()
              ? (
                  <a
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
            <text fg={statusColor(member.status, props.theme)}>●</text>
            <text>{" "}{member.name}</text>
          </box>
          <text fg={props.theme.text.muted}>
            {statusLabel(member.status)}
          </text>
        </box>
      ))}
      {team() ? (
        <box
          flexDirection="row"
          flexWrap="no-wrap"
          width="100%"
          alignItems="center"
        >
          <text fg={props.theme.text.muted} flexShrink={0}>tasks </text>
          <box
            ref={(node) => (barTrack = node)}
            flexDirection="row"
            flexWrap="no-wrap"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            overflow="hidden"
          >
            <text fg={props.theme.text.feedback.success.base}>
              {"━".repeat(completedBars())}
            </text>
            <text fg={props.theme.text.muted}>
              {"─".repeat(Math.max(0, barWidth() - completedBars()))}
            </text>
          </box>
          <text fg={props.theme.text.muted} flexShrink={0}>
            {context()?.tasks.done ?? 0}/{totalTasks()}
          </text>
        </box>
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
