# Prompt Recipes

Good teammate prompts are short, scoped, and verifiable. Include the task, boundaries, and task-specific verification needs. Do not paste a tool list or full reporting format into the prompt; the plugin already injects role context, allowed tools, worktree context, commit/report instructions, and blocker handling.

## Scout Prompt

Use for read-only codebase mapping.

```text
Trace <feature or bug area>. Report:
1. Relevant files and entry points
2. Existing tests and missing test coverage
3. Data model or API contracts involved
4. Risks and likely edge cases
5. The smallest safe implementation slice

Do not edit files. Send one task-result message to the lead with evidence and file paths.
```

Recommended spawn:

```ts
team_spawn({
  name: "scout",
  agent: "explore",
  worktree: false,
  model: "openai/gpt-5-mini",
  prompt: "<scout prompt>",
})
```

## Builder Prompt

Use for one implementation slice.

```text
Implement <specific behavior> in <known files or subsystem>.

Constraints:
- Keep the change narrow.
- Do not refactor unrelated code.
- Add or update tests for the changed behavior.
- Run the relevant verification command and include files changed, tests run, and residual risk in your result.

If blocked, message the lead with the blocker instead of guessing.
```

Use `plan_approval: true` when the builder might touch risky flows or when the lead wants a plan before edits.

## QA Prompt

Use after implementation tasks unblock.

```text
Add regression coverage for <behavior>. Prefer tests that exercise the public API or user-visible flow. Do not duplicate implementation details unless there is no better seam.

Report:
- Tests added or updated
- What failure the tests would catch
- Commands run and result
- Any behavior that remains untested and why

Run the relevant test command and report what coverage was added or left out.
```

## Reviewer Prompt

Use after implementation and QA branches are merged into the lead worktree.

```text
Review the current merged diff for <feature or bug>. Do not edit files.

Check:
- Correctness and edge cases
- Missing tests
- Behavior regressions
- Risky assumptions
- Files that look unrelated to the task

Send one task-result message to the lead with findings ordered by severity. If there are no findings, say that explicitly and list residual risks.
```

Recommended spawn:

```ts
team_spawn({
  name: "reviewer",
  agent: "explore",
  worktree: false,
  model: "openai/gpt-5-mini",
  prompt: "<reviewer prompt>",
})
```

## Lead Setup Prompt To Itself

Before spawning, the lead should be able to answer:

```text
Team goal: <one sentence>
Independent slices: <list>
Shared files to avoid: <list or none>
Risky work needing plan approval: <list>
Verification commands: <commands>
Merge order: <order based on dependencies>
```

If the lead cannot fill this in, start with a single scout instead of a full team.
