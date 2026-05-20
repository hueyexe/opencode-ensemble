import { describe, expect, test } from "bun:test"
import { DASHBOARD_HEAD } from "../src/dashboard-html"
import { DASHBOARD_JS_PART1 } from "../src/dashboard-js-part1"
import { DASHBOARD_JS_PART2 } from "../src/dashboard-js-part2"
import { DASHBOARD_JS_PART3 } from "../src/dashboard-js-part3"

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
    expect(DASHBOARD_HEAD).toContain("max-w-[180px] sm:max-w-[320px] min-w-0")
    expect(DASHBOARD_HEAD).toContain("overflow-x-auto scroll whitespace-nowrap")
  })

  test("agent prioritization helpers are defined", () => {
    expect(DASHBOARD_JS_PART1).toContain("function rankAgent")
    expect(DASHBOARD_JS_PART1).toContain("function deriveAttention")
  })

  test("attention renderer exposes urgent triage copy", () => {
    expect(DASHBOARD_JS_PART2).toContain("function rAttention")
    expect(DASHBOARD_JS_PART2).toContain("Needs attention")
  })

  test("keyboard and accessibility hooks are present", () => {
    expect(DASHBOARD_JS_PART2).toContain("onkeydown")
    expect(DASHBOARD_JS_PART2).toContain("aria-expanded")
    expect(DASHBOARD_JS_PART3).toContain("e.key==='Enter'")
    expect(DASHBOARD_JS_PART3).toContain("e.key==='Escape'")
  })

  test("verbose toggle appears in header chrome", () => {
    expect(DASHBOARD_HEAD).toContain('id="vb"')
    expect(DASHBOARD_HEAD).toContain('id="vt"')
    expect(DASHBOARD_HEAD).toContain('id="vtk"')
    expect(DASHBOARD_HEAD).toContain('aria-pressed')
    expect(DASHBOARD_HEAD).toContain("Toggle verbose mode")
  })

  test("verbose toggle keyboard shortcut in shortcuts overlay", () => {
    expect(DASHBOARD_HEAD).toContain("Toggle verbose")
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
    expect(DASHBOARD_JS_PART3).toContain("function openShortcuts")
    expect(DASHBOARD_JS_PART3).toContain("function closeShortcuts")
    expect(DASHBOARD_JS_PART3).toContain("function setBackgroundInert")
    expect(DASHBOARD_JS_PART3).toContain("function modalOpen")
    expect(DASHBOARD_JS_PART3).toContain("function trapFocus")
    expect(DASHBOARD_JS_PART3).toContain("el.inert=locked")
    expect(DASHBOARD_JS_PART3).toContain("e.key==='Tab'")
    expect(DASHBOARD_JS_PART3).toContain("document.getElementById('sco').focus()")
    expect(DASHBOARD_JS_PART3).toContain("aria-hidden")
    expect(DASHBOARD_JS_PART3).toContain("if(!modalOpen())setBackgroundInert(false)")
  })

  test("agent drawer exposes named close control and modal focus handling", () => {
    expect(DASHBOARD_JS_PART2).toContain('id="drawer-close"')
    expect(DASHBOARD_JS_PART2).toContain('aria-label="Close agent detail"')
    expect(DASHBOARD_JS_PART2).toContain("setBackgroundInert(true)")
    expect(DASHBOARD_JS_PART2).toContain("drawer.inert=false")
    expect(DASHBOARD_JS_PART2).toContain("drawer.inert=true")
    expect(DASHBOARD_JS_PART2).toContain("drawer.focus()")
    expect(DASHBOARD_JS_PART2).toContain("if(!modalOpen())setBackgroundInert(false)")
    expect(DASHBOARD_JS_PART3).toContain("trapFocus(document.getElementById('drawer'),e)")
    expect(DASHBOARD_JS_PART3).toContain("drawerOpen&&e.key==='?'")
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
    expect(DASHBOARD_JS_PART2).not.toContain("opacity-50")
  })

  test("session conversation render helpers are defined", () => {
    expect(DASHBOARD_JS_PART2).toContain("function renderSessionConvo")
    expect(DASHBOARD_JS_PART2).toContain("function fetchSessionConvo")
    expect(DASHBOARD_JS_PART2).toContain("Session Conversation")
    expect(DASHBOARD_JS_PART2).toContain("full agent thinking, tool calls, reasoning")
  })

  test("sessionId field appears in member data rendering", () => {
    expect(DASHBOARD_JS_PART2).toContain("m.sessionId")
  })
})
