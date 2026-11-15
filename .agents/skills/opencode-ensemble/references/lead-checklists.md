# Lead Checklists

Use these gates to prevent common coordination failures.

## Pre-Spawn Checklist

- The user goal is one sentence.
- The task is large enough to justify coordination overhead.
- Each teammate has one clear owner area.
- No two builders are expected to edit the same files.
- Read-only work uses `agent: "explore"` and `worktree: false`.
- Risky implementation work uses `plan_approval: true`.
- Task dependencies are represented with `depends_on`.
- Verification commands are known before work starts.

If more than two items are unknown, spawn one scout first.

## Spawning Checklist

- Call `team_create` before `team_spawn`.
- Add shared tasks with `team_tasks_add` before assigning task IDs.
- Spawn teammates one at a time and wait for each tool result.
- Keep teammate prompts focused and under one clear responsibility.
- Tell teammates what to report, not just what to do.
- Do not describe lead-only tools in teammate prompts.

## While Running Checklist

- Wait for `team_message` updates instead of polling `team_status` repeatedly.
- Use `team_results` for full content when a message is truncated or consequential.
- Forward relevant findings between teammates when it changes their work.
- Reject unclear plans instead of approving them under time pressure.
- Stop and ask the user if teammate outputs conflict with each other or with the user's goal.

## Merge Checklist

- Read the teammate's task result.
- Shut down the teammate with `team_shutdown`.
- If shutdown warns about uncommitted changes, resolve that before merging.
- Merge with `team_merge`, not manual git commands.
- Inspect `git diff` after each merge.
- If two branches overlap in surprising files, review before merging the next branch.

## Cleanup Checklist

- All active teammates are complete, shut down, or intentionally force-stopped.
- Relevant teammate branches have been merged or deliberately left out.
- Verification commands have passed or blockers are clearly reported.
- `team_cleanup` has run after review and verification.
- Final user summary includes what changed, tests run, and any residual risks.

## Verification Checklist

Use the repository's own commands. For opencode-ensemble itself, run:

```bash
bun run typecheck && bun test && bun run build
```

If a command fails, report the failure with the command and error summary. Do not claim the team completed successfully.
