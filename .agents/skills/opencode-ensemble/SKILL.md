---
name: opencode-ensemble
description: "Use when coordinating multiple coding agents, delegating independent software work, managing OpenCode Ensemble teams, choosing teammate roles or models, reviewing teammate output, or deciding whether parallel execution is appropriate."
license: MIT
compatibility: "OpenCode with the @hueyexe/opencode-ensemble plugin installed"
metadata:
  author: hueyexe
  version: "1.2.0"
---

# OpenCode Ensemble

Use OpenCode Ensemble as a coordination system, not a shortcut for avoiding judgment. Parallel agents work best when the lead owns decomposition, sequencing, review, merge, and verification.

## Core Principle

Spawn teammates only for independent, verifiable work. A good Ensemble team has narrow task ownership, clear dependencies, and a lead that integrates results deliberately.

## Use Ensemble When

- Work can be split into independent research, implementation, test, or review slices.
- A read-only scout can map unfamiliar code before edits begin.
- Multiple files or subsystems can be changed without overlapping ownership.
- A risky change benefits from `plan_approval: true` before edits.
- A final reviewer can inspect merged changes without creating another branch.

## Do Not Use Ensemble When

- The task is small enough for one agent to finish quickly.
- The work is tightly coupled and every teammate would need the same files.
- The lead cannot describe each teammate's output and success criteria.
- The user needs one coherent design decision rather than parallel exploration.
- You are tempted to spawn agents because the task feels hard but not divisible.

## Lead Workflow

1. Decide whether parallelism is justified.
2. Create a team with `team_create`.
3. Add tasks with `team_tasks_add`; use `depends_on` for sequencing.
4. Spawn teammates one at a time with `team_spawn`.
5. Use `worktree: false` for read-only `explore` teammates.
6. Use `plan_approval: true` for risky implementation work.
7. Wait for teammate messages instead of polling status repeatedly.
8. Read full results with `team_results` when messages are truncated or consequential.
9. Shut down completed teammates with `team_shutdown`.
10. Merge branches with `team_merge`; inspect the diff before trusting it.
11. Run project verification before `team_cleanup` and before claiming done.

## Role Defaults

| Role | Agent | Worktree | Model guidance | Use for |
|---|---|---:|---|---|
| Scout | `explore` | `false` | e.g. `openai/gpt-5-mini` | Codebase mapping, risk discovery, file ownership plan |
| Builder | `build` | `true` | e.g. `anthropic/claude-opus-4-7` | Narrow implementation slice |
| QA | `build` | `true` | strong model, e.g. `anthropic/claude-opus-4-7` | Tests, fixtures, regression coverage |
| Reviewer | `explore` | `false` | e.g. `openai/gpt-5-mini` | Diff review, risk review, missed-test review |

Model IDs are examples — verify current IDs with your provider. Match cost to the task: cheap models in bulk for scouts and reviewers, smart expensive models for builders doing tricky work, different providers per role if that suits. Always pass an explicit `model` on `team_spawn`: an omitted model falls back to the server default, which may be paid or misconfigured.

Start with two or three teammates. Add more only when the work has more independent slices than active teammates.

## Load References As Needed

- Need a team shape? Read `references/coordination-patterns.md`.
- Need prompts? Read `references/prompt-recipes.md`.
- Need a pre-spawn, merge, cleanup, or verification gate? Read `references/lead-checklists.md`.
- Something feels off or too chatty? Read `references/anti-patterns.md`.
- Creating or improving this skill? Read `references/eval-scenarios.md`.

## Hard Rules

- Do not invent task IDs. `team_tasks_add` generates IDs; use the IDs returned by earlier calls when setting `depends_on` or `claim_task`.
- Keep teammate prompts short. The plugin already injects team role, allowed tools, worktree context, and the required task-result format.
- Do not give teammates vague prompts like "fix the bug" or "work on tests".
- Do not ask teammates to use lead-only tools such as `team_spawn`, `team_shutdown`, `team_merge`, or `team_cleanup`.
- Do not tell teammates to report only in plain text. They must use `team_message`.
- Do not merge a teammate branch without reading its result and inspecting the diff.
- Do not call the work complete until the repository's verification commands pass or you have clearly reported the blocker.
- On OpenCode v2, teammate reports and notifications arrive as persistent synthetic system lines in the transcript, `team_view` switches the TUI only when passed `navigate: true` (never unprompted — that hijacks the user's client), and `team_cleanup` purge needs human approval of the preview before confirmation.

## Minimal Example

```ts
team_create({ name: "checkout-idempotency" })

team_tasks_add({
  tasks: [
    { content: "Map checkout webhook flow and risky files", priority: "high" },
    { content: "Implement duplicate-webhook idempotency guard", priority: "high" },
  ],
})
// Record returned IDs, for example: task_abc123 for scout and task_def456 for builder.

team_tasks_add({
  tasks: [
    { content: "Add duplicate-webhook regression tests", priority: "high", depends_on: ["task_def456"] },
  ],
})
// Record returned QA task ID, for example: task_ghi789.

team_tasks_add({
  tasks: [
    { content: "Review merged diff for correctness and missed tests", priority: "medium", depends_on: ["task_def456", "task_ghi789"] },
  ],
})

team_spawn({
  name: "scout",
  agent: "explore",
  worktree: false,
  model: "openai/gpt-5-mini",
  claim_task: "task_abc123",
  prompt: "Trace the checkout webhook flow. Report files, data model, existing tests, risks, and a smallest-safe-change plan. Do not edit files.",
})

team_spawn({
  name: "api-dev",
  agent: "build",
  model: "anthropic/claude-opus-4-7",
  plan_approval: true,
  claim_task: "task_def456",
  prompt: "Use scout's findings to implement only the idempotency guard. Commit your work and send a task-result message with files changed and tests run.",
})
```
