import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const readmePath = join(root, "README.md");
const skillDir = join(root, ".agents", "skills", "opencode-ensemble");
const skillPath = join(skillDir, "SKILL.md");
const cliSkillPath = join(root, "skills", "opencode-ensemble", "SKILL.md");
const claudeSkillPath = join(root, ".claude", "skills", "opencode-ensemble", "SKILL.md");

const referenceFiles = [
  "coordination-patterns.md",
  "prompt-recipes.md",
  "lead-checklists.md",
  "anti-patterns.md",
  "eval-scenarios.md",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("opencode-ensemble agent skill", () => {
  test("is installable through the skills CLI from the repository README", () => {
    const readme = read(readmePath);

    expect(readme).toContain("npx skills@latest add hueyexe/opencode-ensemble --skill opencode-ensemble");
    expect(readme).toContain("scout: explore agent, worktree disabled");
    expect(readme).toContain("reviewer: explore agent, worktree disabled");
    expect(readme).toContain("openai/gpt-5.3-codex-spark");
    expect(readme).toContain("anthropic/claude-opus-4-7");
    expect(readme).not.toContain("opencode/gpt-5-nano");
    expect(readme).not.toContain("anthropic/claude-opus-4-6");
    expect(readme).toContain("plan_approval: true");
    expect(readme).toContain("depends_on");
    expect(readme).toContain("Record the returned task IDs");
    expect(readme).not.toContain('depends_on: ["task_b"]');
  });

  test("has valid skill frontmatter and progressive-disclosure references", () => {
    const skill = read(skillPath);

    expect(skill).toStartWith("---\n");
    expect(skill).toContain("name: opencode-ensemble\n");
    expect(skill).toContain("Use when coordinating multiple coding agents");
    expect(skill).toContain("# OpenCode Ensemble");
    expect(skill).toContain("references/coordination-patterns.md");
    expect(skill).toContain("references/prompt-recipes.md");
    expect(skill).toContain("references/lead-checklists.md");
    expect(skill).toContain("references/anti-patterns.md");
    expect(skill).toContain("references/eval-scenarios.md");
    expect(skill).toContain("openai/gpt-5-mini");
    expect(skill).toContain("anthropic/claude-opus-4-7");
    expect(skill).not.toContain("openai/gpt-5.3-codex-spark");
    expect(skill).not.toContain("opencode/gpt-5-nano");
    expect(skill).not.toContain("anthropic/claude-opus-4-6");
    expect(skill).toContain("Do not invent task IDs");
    expect(skill).toContain("Keep teammate prompts short");
  });

  test("lives at the OpenCode project compatibility path and remains CLI-installable", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(cliSkillPath)).toBe(true);
    expect(existsSync(claudeSkillPath)).toBe(true);
    expect(read(cliSkillPath)).toBe(read(skillPath));
    expect(read(claudeSkillPath)).toBe(read(skillPath));
  });

  test("ships every referenced skill support file", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(join(skillDir, "README.md"))).toBe(true);

    for (const file of referenceFiles) {
      expect(existsSync(join(skillDir, "references", file))).toBe(true);
    }
  });
});
