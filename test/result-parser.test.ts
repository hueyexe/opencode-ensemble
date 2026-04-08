import { describe, test, expect } from "bun:test"
import { parseTaskResult } from "../src/result-parser"

describe("parseTaskResult", () => {
  test("parses valid task-result with all fields", () => {
    const content = `<task-result>
<status>completed</status>
<summary>Fixed auth middleware</summary>
<details>Added JWT validation to all endpoints</details>
<branch>ensemble-team-alice</branch>
</task-result>`
    const result = parseTaskResult(content)
    expect(result).toEqual({
      status: "completed",
      summary: "Fixed auth middleware",
      details: "Added JWT validation to all endpoints",
      branch: "ensemble-team-alice",
    })
  })

  test("parses without optional branch", () => {
    const content = `<task-result>
<status>completed</status>
<summary>Reviewed code</summary>
<details>Found 3 issues</details>
</task-result>`
    const result = parseTaskResult(content)
    expect(result).toEqual({
      status: "completed",
      summary: "Reviewed code",
      details: "Found 3 issues",
      branch: undefined,
    })
  })

  test("returns null for plain text", () => {
    expect(parseTaskResult("Just a regular message")).toBeNull()
  })

  test("returns null for malformed XML missing required fields", () => {
    const content = `<task-result>
<status>completed</status>
</task-result>`
    expect(parseTaskResult(content)).toBeNull()
  })

  test("handles multiline details", () => {
    const content = `<task-result>
<status>completed</status>
<summary>Big refactor</summary>
<details>Changed 5 files:
- src/auth.ts
- src/middleware.ts
- src/routes.ts

All tests passing.</details>
</task-result>`
    const result = parseTaskResult(content)
    expect(result).not.toBeNull()
    expect(result!.details).toContain("Changed 5 files:")
    expect(result!.details).toContain("All tests passing.")
  })

  test("handles XML-like content that isn't task-result", () => {
    const content = "Here's some code: <div>hello</div> and <span>world</span>"
    expect(parseTaskResult(content)).toBeNull()
  })

  test("handles empty fields gracefully", () => {
    const content = `<task-result>
<status></status>
<summary></summary>
<details></details>
</task-result>`
    expect(parseTaskResult(content)).toBeNull()
  })

  test("parses task-result embedded in surrounding text", () => {
    const content = `Here are my findings:
<task-result>
<status>completed</status>
<summary>Done</summary>
<details>All good</details>
</task-result>
That's all.`
    const result = parseTaskResult(content)
    expect(result).toEqual({
      status: "completed",
      summary: "Done",
      details: "All good",
      branch: undefined,
    })
  })

  test("handles failed status", () => {
    const content = `<task-result>
<status>failed</status>
<summary>Could not complete</summary>
<details>Missing dependency</details>
</task-result>`
    const result = parseTaskResult(content)
    expect(result).not.toBeNull()
    expect(result!.status).toBe("failed")
  })
})
