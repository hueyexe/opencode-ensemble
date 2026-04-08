/** Structured result parsed from `<task-result>` XML. */
export interface TaskResult {
  status: string
  summary: string
  details: string
  branch?: string
}

/**
 * Parse `<task-result>` XML from message content.
 * Returns null if not found or missing required fields.
 */
export function parseTaskResult(content: string): TaskResult | null {
  const match = content.match(/<task-result>([\s\S]*?)<\/task-result>/)
  if (!match) return null

  const inner = match[1]!
  const status = inner.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim()
  const summary = inner.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
  const details = inner.match(/<details>([\s\S]*?)<\/details>/)?.[1]?.trim()
  const branch = inner.match(/<branch>([\s\S]*?)<\/branch>/)?.[1]?.trim()

  if (!status || !summary || !details) return null

  return { status, summary, details, branch: branch || undefined }
}

/**
 * Format a TaskResult as clean readable text.
 */
export function formatTaskResult(from: string, result: TaskResult): string {
  const lines = [
    `[Result from ${from}]:`,
    `  Status: ${result.status}`,
    `  Summary: ${result.summary}`,
    `  Details: ${result.details}`,
  ]
  if (result.branch) lines.push(`  Branch: ${result.branch}`)
  return lines.join("\n")
}
