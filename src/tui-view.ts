/** Minimal member shape for sidebar rendering. */
export interface SidebarMember {
  name: string
  status: string
}

/** Rendered sidebar model: counts plus one line per member. */
export interface SidebarSummary {
  team: string
  working: number
  idle: number
  total: number
  lines: string[]
}

/** Mouse-up events that should activate a dashboard link. */
export interface LinkActivationEvent {
  button: number
  isDragging?: boolean
}

/**
 * Accept only an un-dragged primary-button release as a link activation.
 */
export function isPrimaryLinkActivation(event: LinkActivationEvent): boolean {
  return event.button === 0 && event.isDragging !== true
}

/** Cross-version layout measurement surface for OpenTUI renderables. */
export interface LayoutMeasureNode {
  getLayout?: () => { width: number }
  getLayoutNode?: () => { getComputedWidth: () => number }
}

/** Read a renderable width across OpenTUI versions. */
export function getLayoutWidth(node: LayoutMeasureNode | undefined): number | undefined {
  const layoutWidth = node?.getLayout?.().width
  if (layoutWidth && layoutWidth > 0) return layoutWidth
  return node?.getLayoutNode?.().getComputedWidth()
}

/** Glyph per member status (paired with text elsewhere — never color-only). */
function glyph(status: string): string {
  switch (status) {
    case "busy":
      return "●"
    case "ready":
      return "○"
    case "shutdown_requested":
      return "◐"
    case "shutdown":
      return "■"
    case "error":
      return "✕"
    default:
      return "?"
  }
}

/**
 * Build the sidebar model for a team. Busy members count as working, ready
 * as idle, terminal states (shutdown/error) as done.
 */
export function summarizeMembers(team: string, members: SidebarMember[]): SidebarSummary {
  if (members.length === 0) {
    return { team, working: 0, idle: 0, total: 0, lines: ["No teammates"] }
  }
  let working = 0
  let idle = 0
  const lines = members.map((member) => {
    if (member.status === "busy") working += 1
    else if (member.status === "ready") idle += 1
    return `${glyph(member.status)} ${member.name} (${member.status})`
  })
  return { team, working, idle, total: members.length, lines }
}
