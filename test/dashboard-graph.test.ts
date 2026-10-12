import { describe, expect, test } from "bun:test"
import { DASHBOARD_JS_CORE } from "../src/dashboard-js-core"
import { DASHBOARD_JS_GRAPH_LAYOUT } from "../src/dashboard-js-graph-layout"
import { DASHBOARD_JS_GRAPH } from "../src/dashboard-js-graph"

interface Task { id: string; content: string; status: string; assignee: string | null; dependsOn: string[]; priority: string }
interface Member { name: string; agent: string; status: string; executionStatus: string; model: string }
interface Team { id: string; tasks: Task[]; members: Member[] }
const markup = new Function(`${DASHBOARD_JS_CORE}${DASHBOARD_JS_GRAPH_LAYOUT}${DASHBOARD_JS_GRAPH};return (t,id)=>graphMarkup(t,graphLayout(t.tasks),id)`)() as (t: Team, id?: string) => string
const task = (id: string, dependsOn: string[] = [], assignee: string | null = null): Task => ({ id, content: `Task ${id}`, status: "pending", assignee, dependsOn, priority: "high" })
const member: Member = { name: "api-dev", agent: "build", status: "busy", executionStatus: "running", model: "provider/model" }
const team = (tasks: Task[], members = [member]): Team => ({ id: "team-a", tasks, members })

describe("dependency graph rendering", () => {
  test("cards retain all tasks including multiple tasks for one agent", () => {
    const html = markup(team([task("a", [], "api-dev"), task("b", ["a"], "api-dev")]))
    expect(html.match(/data-graph-task=/g)).toHaveLength(2)
    expect(html).toContain("Task a")
    expect(html).toContain("Task b")
    expect(html).toContain("api-dev")
    expect(html).toContain("working")
    expect(html).toContain("build")
    expect(html).toContain("provider/model")
    expect(html).toContain("pending")
    expect(html).toContain('data-edge-from="a" data-edge-to="b"')
  })

  test("unassigned and removed assignees never link to nonexistent drawers", () => {
    const html = markup(team([task("a"), task("b", [], "removed")]), "b")
    expect(html).toContain("Unassigned")
    expect(html).toContain("removed")
    expect(html).toContain("Agent not in roster")
    expect(html).not.toContain("data-graph-agent=")
  })

  test("task inspection lists prerequisites, dependents, and assigned agent", () => {
    const html = markup(team([task("a"), task("b", ["a"], "api-dev"), task("c", ["b"])]), "b")
    expect(html).toContain("Prerequisites")
    expect(html).toContain("Dependents")
    expect(html).toContain('data-graph-select="a"')
    expect(html).toContain('data-graph-select="c"')
    expect(html).toContain('data-graph-agent="api-dev"')
    expect(html).toContain('aria-pressed="true"')
  })

  test("dependency completion removes derived blocked labels without changing task status", () => {
    const t = team([task("a"), task("b", ["a"])])
    expect(markup(t)).toContain("Blocked by 1 prerequisite")
    t.tasks[0]!.status = "completed"
    expect(markup(t)).not.toContain("Blocked by 1 prerequisite")
    expect(markup(t)).toContain("Prerequisites satisfied")
    expect(t.tasks[1]!.status).toBe("pending")
  })

  test("cancelled prerequisites are resolved just as they are in the scheduler", () => {
    const t = team([{ ...task("a"), status: "cancelled" }, task("b", ["a"])])
    const html = markup(t)
    expect(html).not.toContain("Blocked by 1 prerequisite")
    expect(html).not.toContain("graph-card graph-blocked")
    expect(html).toContain("Prerequisites satisfied")
  })

  test("cycles and missing tasks produce visible warnings and retain cards", () => {
    const html = markup(team([task("a", ["b"]), task("b", ["a", "gone"])]), "b")
    expect(html).toContain("Cyclic dependencies")
    expect(html).toContain("Missing prerequisite")
    expect(html).toContain("gone")
    expect(html.match(/data-graph-task=/g)).toHaveLength(2)
  })

  test("direct dependencies that skip a column route below intervening cards", () => {
    const html = markup(team([task("a"), task("b", ["a"]), task("c", ["a", "b"])]))
    const path = html.match(/data-edge-from="a" data-edge-to="c" d="([^"]+)"/)![1]!
    expect(path).toContain(" V ")
    const routeY = Number(path.match(/ V (\d+)/)?.[1])
    expect(routeY).toBeGreaterThan(196)
    const height = Number(html.match(/class="graph-edges" width="\d+" height="(\d+)"/)![1])
    expect(height).toBeGreaterThan(routeY)
  })

  test("empty teams show a useful task creation hint", () => {
    const html = markup(team([]))
    expect(html).toContain("No tasks yet")
    expect(html).toContain("team_tasks_add")
    expect(html).not.toContain("<svg")
  })

  test("hostile task IDs, task text, agent names and models stay escaped", () => {
    const hostile = '\"><img src=x onerror=alert(1)>'
    const t = team([{ ...task(hostile, [], hostile), content: hostile }], [{ ...member, name: hostile, model: hostile }])
    const html = markup(t, hostile)
    expect(html).toContain("&quot;&gt;&lt;img")
    expect(html).not.toContain("<img")
    expect(html).not.toContain('data-graph-task=""><')
    expect(html).not.toContain("onclick=")
  })

  test("completed and cancelled tasks keep their terminal status despite unfinished prerequisites", () => {
    const t = team([task("a"), { ...task("b", ["a"]), status: "completed" }, { ...task("c", ["a"]), status: "cancelled" }])
    const html = markup(t)
    expect(html).toContain("completed")
    expect(html).toContain("cancelled")
    expect(html).not.toContain("Blocked by 1 prerequisite")
  })
})

describe("dependency graph view state", () => {
  function harness(initial: Team) {
    const elements = new Map<string, { hidden: boolean; innerHTML: string; writes: number; scrollLeft: number; scrollTop: number; tabIndex: number; attrs: Record<string, string>; setAttribute(key: string, value: string): void; focus(): void; contains(): boolean; querySelectorAll(): [] }>()
    const get = (id: string) => {
      if (!elements.has(id)) {
        let serialized = ""
        elements.set(id, {
          hidden: false, writes: 0, scrollLeft: 0, scrollTop: 0, tabIndex: 0, attrs: {},
          get innerHTML() { return serialized },
          set innerHTML(html) { this.writes++; serialized = html.replace(/<path([^>]*)\/>/g, "<path$1></path>") },
          setAttribute(key, value) { this.attrs[key] = value }, focus() {}, contains() { return false }, querySelectorAll() { return [] },
        })
      }
      return elements.get(id)!
    }
    const document = { getElementById: get, activeElement: null }
    const api = new Function("document", "initial", `${DASHBOARD_JS_CORE}${DASHBOARD_JS_GRAPH_LAYOUT}${DASHBOARD_JS_GRAPH};
      S={teams:[initial]};selId=initial.id;
      return {selectDashboardTab,rGraph,selectGraphTask,resetGraphView,
      update:t=>{S={teams:[t]};selId=t.id;rGraph(t)},view:()=>dashboardTab,
      selected:()=>graphSelectedId,key:graphTabKeydown};`)(document, initial) as {
        selectDashboardTab(view: string): void; rGraph(t: Team): void; selectGraphTask(id: string): void; resetGraphView(): void
        update(t: Team): void; view(): string; selected(): string | null
        key(e: { key: string; preventDefault(): void; target: { id: string } }): void
      }
    return { api, get }
  }

  test("tab changes expose only the selected panel and preserve tab state on refresh", () => {
    const t = team([task("a")]), { api, get } = harness(t)
    api.selectDashboardTab("dependencies")
    expect(api.view()).toBe("dependencies")
    expect(get("panel-overview").hidden).toBe(true)
    expect(get("panel-dependencies").hidden).toBe(false)
    expect(get("tab-dependencies").attrs["aria-selected"]).toBe("true")
    expect(get("tab-overview").tabIndex).toBe(-1)
    api.update(t)
    expect(api.view()).toBe("dependencies")
    api.selectDashboardTab("overview")
    expect(get("panel-dependencies").hidden).toBe(true)
  })

  test("unchanged refresh does not replace graph controls after browser SVG serialization", () => {
    const t = team([task("a"), task("b", ["a"])]), { api, get } = harness(t)
    api.selectDashboardTab("dependencies")
    expect(get("graph-content").writes).toBe(1)
    api.update(t)
    expect(get("graph-content").writes).toBe(1)
    api.update({ ...t, tasks: [{ ...t.tasks[0]!, status: "completed" }, t.tasks[1]!] })
    expect(get("graph-content").writes).toBe(2)
  })

  test("live updates preserve graph scroll and clear disappeared task selection", () => {
    const t = team([task("a")]), { api, get } = harness(t)
    api.selectDashboardTab("dependencies"); api.selectGraphTask("a")
    expect(api.selected()).toBe("a")
    get("graph-scroll").scrollLeft = 160; get("graph-scroll").scrollTop = 80
    api.update({ ...t, tasks: [] })
    expect(api.selected()).toBeNull()
    expect(get("graph-scroll").scrollLeft).toBe(160)
    expect(get("graph-scroll").scrollTop).toBe(80)
  })

  test("team switches clear stale task details and reset graph scroll", () => {
    const t = team([task("a")]), { api, get } = harness(t)
    api.selectDashboardTab("dependencies"); api.selectGraphTask("a")
    get("graph-scroll").scrollLeft = 160
    api.update({ ...t, id: "team-b", tasks: [task("a")] })
    expect(api.selected()).toBeNull()
    expect(get("graph-scroll").scrollLeft).toBe(0)
    expect(api.view()).toBe("dependencies")
  })

  test("tab arrow, home, and end keys select the corresponding view", () => {
    const { api } = harness(team([]))
    api.key({ key: "ArrowRight", target: { id: "tab-overview" }, preventDefault() {} })
    expect(api.view()).toBe("dependencies")
    api.key({ key: "Home", target: { id: "tab-dependencies" }, preventDefault() {} })
    expect(api.view()).toBe("overview")
    api.key({ key: "End", target: { id: "tab-overview" }, preventDefault() {} })
    expect(api.view()).toBe("dependencies")
    api.key({ key: "ArrowLeft", target: { id: "tab-dependencies" }, preventDefault() {} })
    expect(api.view()).toBe("overview")
  })

  test("reset view restores scroll without discarding the selected task", () => {
    const { api, get } = harness(team([task("a")]))
    api.selectGraphTask("a"); get("graph-scroll").scrollLeft = 200
    api.resetGraphView()
    expect(get("graph-scroll").scrollLeft).toBe(0)
    expect(api.selected()).toBe("a")
  })
})
