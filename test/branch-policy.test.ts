import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const workflowPath = join(root, ".github", "workflows", "branch-name.yml")
const contributingPath = join(root, "CONTRIBUTING.md")

describe("branch naming policy", () => {
  test("documents the allowed branch prefixes", () => {
    const contributing = readFileSync(contributingPath, "utf8")

    expect(contributing).toContain("bugfix/")
    expect(contributing).toContain("feature/")
    expect(contributing).toContain("chore/")
  })

  test("checks pull request branches for allowed prefixes", () => {
    expect(existsSync(workflowPath)).toBe(true)

    const workflow = readFileSync(workflowPath, "utf8")
    expect(workflow).toContain("pull_request")
    expect(workflow).toContain("github.head_ref")
    expect(workflow).toContain("HEAD_REF: ${{ github.head_ref }}")
    expect(workflow).toContain('case "$HEAD_REF" in')
    expect(workflow).not.toContain('case "${{ github.head_ref }}" in')
    expect(workflow).toContain("bugfix/*")
    expect(workflow).toContain("feature/*")
    expect(workflow).toContain("chore/*")
  })
})
