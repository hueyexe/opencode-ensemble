/** @jsxImportSource @opentui/solid */
import "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { EnsembleRpc } from "./rpc"
import { fetchTeamContext, type TeamContextData } from "./tui-context"
import { formatSidebarTask } from "./tui-view"

/** Sidebar widget: team members with status plus task counts. */
function TeamSidebar(props: { fetchContext: () => Promise<TeamContextData | null>; onEvent: (cb: () => void) => () => void }) {
  const [state, setState] = createSignal<TeamContextData | null>(null)
  const load = async (): Promise<void> => {
    try {
      setState(await props.fetchContext())
    } catch {
      // Server unreachable — keep the last known state.
    }
  }
  onMount(() => {
    void load()
    const off = props.onEvent(() => void load())
    onCleanup(off)
    // Heartbeat: events alone go stale (cleanup emits nothing, events can be
    // missed across reconnects). Re-fetch on a slow tick — local RPC read.
    const tick = setInterval(() => void load(), 10_000)
    onCleanup(() => clearInterval(tick))
  })
  return (
    <Show when={state()?.team} fallback={<text>Ensemble: no active team</text>}>
      <box flexDirection="column">
        <text>Ensemble: {state()?.team}</text>
        {(state()?.members ?? []).map((member) => (
          <text>
            {member.status === "busy" ? "●" : member.status === "ready" ? "○" : "■"} {member.name} ({member.status})
          </text>
        ))}
        <Show when={(state()?.openTasks?.length ?? 0) > 0}>
          <text>Tarefas abertas:</text>
          {(state()?.openTasks ?? []).map((task) => (
            <box flexDirection="column">
              {formatSidebarTask(task).map((line) => <text>{line}</text>)}
            </box>
          ))}
        </Show>
        <text>
          tasks: {(state()?.tasks.pending ?? 0)} open / {(state()?.tasks.done ?? 0)} done
        </text>
      </box>
    </Show>
  )
}

/**
 * Terminal companion for opencode-ensemble (issue #36).
 *
 * Two persistent surfaces only — transient toasts were removed as noise
 * (live state lives in the sidebar; events live in the transcript as
 * synthetic system lines):
 *   1. Sidebar widget: live member status + task counts.
 *   2. Native agent switching: team_view with navigate: true (user opt-in
 *      only — agents never hijack the client unprompted).
 *
 * Enhancement only: desktop, web, and companion-less terminals lose nothing
 * functional — tools, approvals, model-context messages, and the dashboard
 * all live server-side.
 */
export default Plugin.define({
  id: "ensemble.tui",
  setup(context) {
    const rpc = context.client.rpc(EnsembleRpc)

    // Native agent switching: team_view(navigate: true) emits "view";
    // the companion navigates the TUI to the teammate session (ctrl+p to return).
    const offView = rpc.events.on("view", (event) => {
      const data = event.data as unknown as { sessionID: string }
      if (!data.sessionID) return
      if (context.ui.tabs.enabled()) {
        void context.ui.tabs.focus(data.sessionID)
      } else {
        void context.ui.router.navigate({ type: "session", sessionID: data.sessionID })
      }
    })

    const onEvent = (cb: () => void): (() => void) => rpc.events.on("member", cb)

    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (panel: { sessionID?: string }) => (
        <TeamSidebar
          fetchContext={() => fetchTeamContext(context, rpc, panel.sessionID)}
          onEvent={onEvent}
        />
      ),
    })

    return () => {
      offView()
      offSidebar()
    }
  },
})
