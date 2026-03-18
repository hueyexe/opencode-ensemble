# OpenCode Ensemble

Run a team of parallel AI agents in OpenCode. Each agent gets its own session, context window, and task. They coordinate through messaging and a shared task board.

Built as a plugin on the public OpenCode SDK. Zero internal dependencies.

## What actually happens

You ask the agent to do something complex. The agent decides it needs help, creates a team, and spawns teammates. Each teammate gets its own OpenCode session with a fresh context window and a specific task.

Here's a real interaction:

```
You: "Add input validation to all API endpoints and write tests for each one."

The lead agent:
1. Creates a team called "validation"
2. Adds tasks to the shared board: one per endpoint
3. Spawns 3 teammates:
   - alice: validate user endpoints (POST /users, PUT /users/:id)
   - bob: validate order endpoints (POST /orders, PUT /orders/:id)
   - carol: write integration tests for all validated endpoints
4. carol's tasks depend on alice and bob finishing first
```

From here, things happen in parallel. Alice and bob work simultaneously in their own sessions. You see toast notifications as they make progress:

```
[toast] Teammate alice spawned (build)
[toast] Teammate bob spawned (build)
[toast] Teammate carol spawned (build)
```

The teammates talk to each other and to the lead:

```
alice -> lead: "User validation done. Added zod schemas to POST /users and PUT /users/:id."
bob -> lead: "Order validation done. Found an edge case in PUT /orders/:id — negative quantities were allowed."
bob -> alice: "Did you handle email format validation? I want to match the pattern for order contact emails."
alice -> bob: "Yes, using z.string().email() — see src/validators/user.ts line 12."
```

When alice and bob finish, carol's blocked tasks unblock automatically. Carol starts writing tests using the actual validation schemas alice and bob created.

The lead keeps you updated throughout. You can check on things at any time:

```
You: "How's the team doing?"

Lead calls team_status:
  Team: validation (you are the lead)
  Members:
    alice   [idle]     agent: build  session: ses_abc
    bob     [idle]     agent: build  session: ses_def
    carol   [working]  agent: build  session: ses_ghi
  Tasks: 5 total (3 completed, 1 in_progress, 1 pending)
```

Want to see what carol is actually doing? The lead can switch your view to her session:

```
You: "Show me what carol is working on."

Lead calls team_view({ member: "carol" })
-> TUI switches to carol's session, showing her full chat log
-> Use the session picker (ctrl+p) to go back to the lead
```

When everything is done, the lead shuts down teammates and cleans up:

```
[toast] alice shut down
[toast] bob shut down
[toast] carol shut down

Lead: "All validation and tests are complete. 5 endpoints validated,
       12 test cases added. Team cleaned up."
```

## Install

Add the plugin to your OpenCode config. This can be project-level or global.

**Project-level** — `opencode.json` in your project root:

```json
{
  "plugin": ["@hueyexe/opencode-ensemble"]
}
```

**Global** — `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@hueyexe/opencode-ensemble"]
}
```

That's it. OpenCode auto-installs npm plugins at startup (cached in `~/.cache/opencode/node_modules/`). No `npm install` or `bun add` needed.

### Local development

For working on the plugin itself, create `.opencode/plugins/ensemble.ts` in your project:

```ts
export { default } from "@hueyexe/opencode-ensemble"
```

Or point directly at the source checkout:

```ts
export { default } from "/path/to/opencode-ensemble/src/index.ts"
```

## Tools

13 tools total. The lead has all of them. Teammates get 6 (messaging + tasks).

**Team lifecycle** (lead only)

| Tool | What it does |
|------|-------------|
| `team_create` | Create a team. Caller becomes the lead. |
| `team_spawn` | Start a new teammate with a task. |
| `team_shutdown` | Ask a teammate to stop. |
| `team_cleanup` | Remove the team when done. |
| `team_status` | See all members, their status, and a task summary. |
| `team_view` | Switch the TUI to a teammate's session. |

**Communication** (everyone)

| Tool | What it does |
|------|-------------|
| `team_message` | Send a direct message to a teammate or the lead. |
| `team_broadcast` | Message everyone on the team. |
| `team_results` | Retrieve full message content (messages to lead are truncated on delivery). |

**Task board** (everyone)

| Tool | What it does |
|------|-------------|
| `team_tasks_list` | See all tasks with status and assignee. |
| `team_tasks_add` | Add tasks to the shared board. |
| `team_tasks_complete` | Mark a task done. Unblocks dependents. |
| `team_claim` | Claim a pending task. Atomic, prevents double-claims. |

## What you see in the TUI

The plugin works within OpenCode's existing TUI. There's no custom team panel (that requires core TUI changes, which are [in progress upstream](https://github.com/sst/opencode)).

What you do get:

- **Toast notifications** when teammates spawn, finish, error, shut down, or get rate-limited
- **Working progress toasts** showing who's still active after every status change (e.g. "Working: alice, bob (2/3)")
- **Rich tool titles** in the sidebar (e.g. "Spawned alice (build)", "Message -> bob", "Task board (3 tasks)")
- **Session switching** via `team_view` to see any teammate's full chat log
- **Status checks** via `team_status` for a snapshot of the whole team (also fires a toast)

Teammate messages arrive in the lead's session as `[Team message from alice]: ...` blocks. They look like user messages in the TUI because that's how `promptAsync` delivery works. The content is clearly labeled with the sender's name.

## Architecture

- **SQLite** (`bun:sqlite`, WAL mode) for teams, members, tasks, and messages
- **promptAsync** for message delivery: injects a message and starts the prompt loop in one call
- **Git worktree isolation**: each teammate gets their own worktree by default, so multiple agents can edit files without conflicts. The lead merges branches after cleanup. Opt out with `worktree: false` for read-only agents.
- **Sub-agent isolation**: teammates' sub-agents can't use team tools (parent chain tracking, max depth 10)
- **Crash recovery**: stale busy members marked as errored on restart, orphaned sessions aborted, orphaned worktrees cleaned up, undelivered messages redelivered
- **Spawn rollback**: if the initial prompt fails, the member, session, and worktree are all cleaned up
- **Timeout watchdog**: teammates stuck busy beyond the TTL are automatically timed out and aborted
- **Shutdown resilience**: abort failures handled gracefully, busy-after-shutdown triggers re-abort
- **Rate limiting**: token bucket (configurable via `OPENCODE_ENSEMBLE_RATE_LIMIT`, default 10 tokens/sec)

## Configuration

```bash
# Adjust rate limit (default: 10 tokens, refills 2/sec)
OPENCODE_ENSEMBLE_RATE_LIMIT=20

# Disable rate limiting
OPENCODE_ENSEMBLE_RATE_LIMIT=0

# Adjust teammate timeout (default: 1800000ms = 30 minutes)
OPENCODE_ENSEMBLE_TIMEOUT=3600000

# Disable timeout watchdog
OPENCODE_ENSEMBLE_TIMEOUT=0
```

### Best practices

- Start with 2-4 teammates for most tasks. More agents means more coordination overhead.
- Give each teammate 3-5 specific, self-contained tasks. Vague prompts produce vague results.
- Start with research before implementation — spawn an explore agent first to understand the codebase, then spawn build agents with that context.
- Use `worktree: false` for read-only agents (research, review, code analysis). They don't need file isolation.
- Use `plan_approval: true` for risky changes — the teammate sends a plan first, you review and approve before they write any code.
- Let the lead coordinate. Don't micromanage teammates — they message you when done or when they're blocked.
- After spawning, tell the user what you've set up and wait for results. Don't poll `team_status` in a loop.

### How this differs from Claude Code agent teams

Claude Code has built-in agent teams. This plugin takes the same coordination model (shared tasks, peer messaging, lead coordination) and adds:

- **Git worktree isolation by default** — each teammate gets their own branch, no merge conflicts between parallel agents
- **System prompt injection** — the lead's system prompt is updated with team state (member statuses, task progress) so it stays aware across turns
- **Compaction safety** — team context is preserved when sessions get long and OpenCode compacts the conversation
- **Team-aware shell environment** — teammate shells get `ENSEMBLE_TEAM`, `ENSEMBLE_MEMBER`, `ENSEMBLE_ROLE`, and `ENSEMBLE_BRANCH` variables
- **Graceful shutdown** — teammates finish their current work before stopping, with a force flag for emergencies
- **Plan approval mode** — review teammate plans before they write code, useful for risky or unfamiliar changes
- **Works today as a plugin** — no waiting for upstream features, install and go

## Development

```bash
bun install
bun run typecheck
bun test             # 144 tests
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
