import { describe, expect, test } from "bun:test"
import { DASHBOARD_HEAD } from "../src/dashboard-html"
import { DASHBOARD_JS_CORE } from "../src/dashboard-js-core"
import { DASHBOARD_JS_EVENTS } from "../src/dashboard-js-events"
import { DASHBOARD_JS_RENDER } from "../src/dashboard-js-render"

function colorToken(group: string, key: string): string {
  const match = DASHBOARD_HEAD.match(new RegExp(`${group}:\\{[^}]*${key}:'#([0-9a-f]{6})'`))
  if (!match?.[1]) throw new Error(`Missing color token ${group}.${key}`)
  return match[1]
}

function contrastRatio(foreground: string, background: string): number {
  const channel = (hex: string, index: number) => Number.parseInt(hex.slice(index, index + 2), 16) / 255
  const linear = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  const luminance = (hex: string) => (0.2126 * linear(channel(hex, 0))) + (0.7152 * linear(channel(hex, 2))) + (0.0722 * linear(channel(hex, 4)))
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe("dashboard UI contract", () => {
  test("HTML shell exposes triage cockpit regions", () => {
    expect(DASHBOARD_HEAD).toContain('id="attention"')
    expect(DASHBOARD_HEAD).toContain('aria-label="Team attention"')
    expect(DASHBOARD_HEAD).toContain('aria-label="Project navigation"')
    expect(DASHBOARD_HEAD).toContain('aria-label="Agent roster"')
    expect(DASHBOARD_HEAD).toContain('aria-label="Task board"')
    expect(DASHBOARD_HEAD).toContain('aria-label="Activity feed"')
    expect(DASHBOARD_HEAD).toContain('aria-label="Event timeline"')
    expect(DASHBOARD_HEAD).toContain('id="drawer-title"')
    expect(DASHBOARD_HEAD).toContain('id="drawer" class="scroll p-4" tabindex="-1" inert')
  })

  test("fixed dashboard chrome is constrained on narrow viewports", () => {
    expect(DASHBOARD_HEAD).toContain("px-3 sm:px-4")
    expect(DASHBOARD_HEAD).toContain("gap-2 sm:gap-3 min-w-0 flex-1")
    expect(DASHBOARD_HEAD).toContain("overflow-x-auto scroll whitespace-nowrap")
  })

  test("project navigation uses docs-style outline semantics", () => {
    expect(DASHBOARD_HEAD).toContain('id="projects"')
    expect(DASHBOARD_JS_RENDER).toContain('<nav class="text-[12px]"')
    expect(DASHBOARD_JS_RENDER).toContain('class="project-link')
    expect(DASHBOARD_JS_RENDER).toContain('class="team-link')
    expect(DASHBOARD_JS_RENDER).toContain('border-l-2')
    expect(DASHBOARD_JS_RENDER).toContain("function renderProjectNavHeader")
    expect(DASHBOARD_JS_RENDER).toContain("function renderProjectButton")
    expect(DASHBOARD_JS_RENDER).toContain("function renderTeamLink")
    expect(DASHBOARD_JS_RENDER).toContain("[...teams].sort")
    expect(DASHBOARD_JS_RENDER).toContain("statusTitleProject")
    expect(DASHBOARD_JS_RENDER).toContain("statusTitleTeam")
    expect(DASHBOARD_JS_CORE).toContain("function projectLabel")
    expect(DASHBOARD_JS_EVENTS).toContain("function selectProject")
    expect(DASHBOARD_JS_EVENTS).toContain("function selectTeam")
  })

  test("project navigation can collapse", () => {
    expect(DASHBOARD_HEAD).not.toContain('<button id="nav-toggle"')
    expect(DASHBOARD_HEAD).toContain('id="project-rail"')
    expect(DASHBOARD_HEAD).toContain('id="nav-expand"')
    expect(DASHBOARD_JS_RENDER).toContain('id="nav-toggle"')
    expect(DASHBOARD_JS_RENDER).toContain('aria-label="Hide project navigation"')
    expect(DASHBOARD_HEAD).toContain("#content.nav-collapsed")
    expect(DASHBOARD_HEAD).toContain("#projects[hidden]")
    expect(DASHBOARD_HEAD).toContain("#project-rail[hidden]")
    expect(DASHBOARD_JS_EVENTS).toContain("function applyNavCollapse")
    expect(DASHBOARD_JS_EVENTS).toContain("id==='nav-toggle'")
    expect(DASHBOARD_JS_EVENTS).toContain("aria-expanded")
    expect(DASHBOARD_JS_EVENTS).toContain("projects.hidden=navCollapsed")
    expect(DASHBOARD_JS_EVENTS).toContain("rail.hidden=!navCollapsed")
    expect(DASHBOARD_JS_EVENTS).toContain("expand.focus()")
    expect(DASHBOARD_JS_EVENTS).toContain("toggle.focus()")
    expect(DASHBOARD_JS_EVENTS).toContain("aria-hidden")
  })

  test("dashboard polls state relative to the served page", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("fetch('api/state')")
    expect(DASHBOARD_JS_EVENTS).not.toContain("fetch('/api/state')")
  })

  test("agent prioritization helpers are defined", () => {
    expect(DASHBOARD_JS_CORE).toContain("function rankAgent")
    expect(DASHBOARD_JS_CORE).toContain("function deriveAttention")
  })

  test("attention renderer exposes urgent triage copy", () => {
    expect(DASHBOARD_JS_RENDER).toContain("function rAttention")
    expect(DASHBOARD_JS_RENDER).toContain("Needs attention")
  })

  test("keyboard and accessibility hooks are present", () => {
    expect(DASHBOARD_JS_RENDER).toContain("onkeydown")
    expect(DASHBOARD_JS_RENDER).toContain("aria-expanded")
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='Enter'")
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='Escape'")
  })

  test("shortcut overlay exposes dialog semantics", () => {
    expect(DASHBOARD_HEAD).toContain('id="sco" role="dialog"')
    expect(DASHBOARD_HEAD).toContain('aria-modal="true"')
    expect(DASHBOARD_HEAD).toContain('aria-hidden="true"')
    expect(DASHBOARD_HEAD).toContain('aria-labelledby="shortcuts-title"')
    expect(DASHBOARD_HEAD).toContain('tabindex="-1"')
    expect(DASHBOARD_HEAD).toContain('id="shortcuts-title"')
  })

  test("shortcut overlay manages modal focus", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("function openShortcuts")
    expect(DASHBOARD_JS_EVENTS).toContain("function closeShortcuts")
    expect(DASHBOARD_JS_EVENTS).toContain("function setBackgroundInert")
    expect(DASHBOARD_JS_EVENTS).toContain("function modalOpen")
    expect(DASHBOARD_JS_EVENTS).toContain("function trapFocus")
    expect(DASHBOARD_JS_EVENTS).toContain("el.inert=locked")
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='Tab'")
    expect(DASHBOARD_JS_EVENTS).toContain("document.getElementById('sco').focus()")
    expect(DASHBOARD_JS_EVENTS).toContain("aria-hidden")
    expect(DASHBOARD_JS_EVENTS).toContain("if(!modalOpen())setBackgroundInert(false)")
  })

  test("agent drawer exposes named close control and modal focus handling", () => {
    expect(DASHBOARD_JS_RENDER).toContain('id="drawer-close"')
    expect(DASHBOARD_JS_RENDER).toContain('aria-label="Close agent detail"')
    expect(DASHBOARD_JS_RENDER).toContain("setBackgroundInert(true)")
    expect(DASHBOARD_JS_RENDER).toContain("drawer.inert=false")
    expect(DASHBOARD_JS_RENDER).toContain("drawer.inert=true")
    expect(DASHBOARD_JS_RENDER).toContain("drawer.focus()")
    expect(DASHBOARD_JS_RENDER).toContain("if(!modalOpen())setBackgroundInert(false)")
    expect(DASHBOARD_JS_EVENTS).toContain("trapFocus(document.getElementById('drawer'),e)")
    expect(DASHBOARD_JS_EVENTS).toContain("drawerOpen&&e.key==='?'")
  })

  test("small dashboard text tokens stay readable on dark surfaces", () => {
    const darkSurfaces = [colorToken("base", "950"), colorToken("base", "900")]
    const smallText = [colorToken("txt", "400"), colorToken("txt", "500")]

    for (const text of smallText) {
      for (const surface of darkSurfaces) {
        expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("agent cards do not dim operational text with whole-card opacity", () => {
    expect(DASHBOARD_JS_RENDER).not.toContain("opacity-50")
  })
})
