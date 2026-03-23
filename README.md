# OpenCode Ensemble

Run parallel AI agents in OpenCode. Each agent gets its own session, context window, and task. They coordinate through messaging and a shared task board.

Plugin built on the public OpenCode SDK. No internal dependencies.

## What actually happens

You ask the agent to do something complex. It creates a team, spawns teammates, and they work in parallel. Each teammate runs in its own OpenCode session with a fresh context window.

A real interaction:

```
You: "Add input validation to all API endpoints and write tests for each one."

The lead agent:
1. Creates a team called "validation"
2. Adds tasks to the shared board, one per endpoint
3. Spawns 3 teammates:
   - alice: validate user endpoints (POST /users, PUT /users/:id)
   - bob: validate order endpoints (POST /orders, PUT /orders/:id)
   - carol: write integration tests for all validated endpoints
4. carol's tasks depend on alice and bob finishing first
```

Alice and bob work simultaneously. You see toast notifications as they progress:

```
[toast] Teammate alice spawned (build)
[toast] Teammate bob spawned (build)
[toast] Teammate carol spawned (build)
```

Teammates talk to each other and to the lead:

```
alice -> lead: "User validation done. Added zod schemas to POST /users and PUT /users/:id."
bob -> lead: "Order validation done. Found an edge case in PUT /orders/:id, negative quantities were allowed."
bob -> alice: "Did you handle email format validation? I want to match the pattern for order contact emails."
alice -> bob: "Yes, using z.string().email(). See src/validators/user.ts line 12."
```

When alice and bob finish, carol's blocked tasks unblock automatically. Carol starts writing tests using the validation schemas they created.

Check on things at any time:

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

Want to see what carol is doing? The lead can switch your view to her session:

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

Add the plugin to your OpenCode config. Project-level or global.

**Project-level** (`opencode.json` in your project root):

```json
{
  "plugin": ["@hueyexe/opencode-ensemble"]
}
```

**Global** (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@hueyexe/opencode-ensemble"]
}
```

OpenCode auto-installs npm plugins at startup (cached in `~/.cache/opencode/node_modules/`). No `npm install` needed.

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

13 tools. The lead has all of them. Teammates get 6 (messaging + tasks).

**Team lifecycle** (lead only)

| Tool | What it does |
|------|-------------|
| `team_create` | Create a team. Caller becomes the lead. |
| `team_spawn` | Start a new teammate with a task. Supports `plan_approval` mode. |
| `team_shutdown` | Ask a teammate to stop. Supports `force` flag for immediate abort. |
| `team_cleanup` | Remove the team when done. |
| `team_status` | See all members, their status, and a task summary. |
| `team_view` | Switch the TUI to a teammate's session. |

**Communication** (everyone)

| Tool | What it does |
|------|-------------|
| `team_message` | Send a direct message to a teammate or the lead. Also handles plan approval/rejection. |
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

The plugin works within OpenCode's existing TUI. No custom team panel (that requires core TUI changes, which are [in progress upstream](https://github.com/sst/opencode)).

What you get:

- **Toast notifications** when teammates spawn, finish, error, shut down, or get rate-limited
- **Working progress toasts** showing who's still active after every status change (e.g. "Working: alice, bob (2/3)")
- **Rich tool titles** in the sidebar (e.g. "Spawned alice (build)", "Message -> bob", "Task board (3 tasks)")
- **Session switching** via `team_view` to see any teammate's full chat log
- **Status checks** via `team_status` for a snapshot of the whole team

Teammate messages arrive in the lead's session as `[Team message from alice]: ...` blocks. They look like user messages because that's how `promptAsync` delivery works. Content is clearly labeled with the sender's name.

## Architecture

- **SQLite** (`bun:sqlite`, WAL mode) for teams, members, tasks, and messages
- **promptAsync** for message delivery: injects a message and starts the prompt loop in one call
- **Git worktree isolation**: each teammate gets their own worktree by default, so multiple agents can edit files without conflicts. Opt out with `worktree: false` for read-only agents.
- **System prompt injection**: the lead's system prompt includes team state (member statuses, task counts) on every LLM call. Teammates get a short role reminder.
- **Compaction safety**: team context is preserved when OpenCode compacts long conversations
- **Shell environment**: teammate shells get `ENSEMBLE_TEAM`, `ENSEMBLE_MEMBER`, `ENSEMBLE_ROLE`, and `ENSEMBLE_BRANCH` variables
- **Sub-agent isolation**: teammates' sub-agents can't use team tools (parent chain tracking, max depth 10)
- **Crash recovery**: stale busy members marked as errored on restart, orphaned sessions aborted, orphaned worktrees cleaned up, undelivered messages redelivered
- **Spawn rollback**: if the initial prompt fails, the member, session, and worktree are all cleaned up
- **Timeout watchdog**: teammates stuck busy beyond the TTL are automatically timed out and aborted
- **Graceful shutdown**: busy teammates receive a shutdown message and finish their current work. Use `force: true` to abort immediately.
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

## Best practices

- Start with 2-3 teammates. More agents means more coordination overhead.
- Give each teammate specific, self-contained tasks. Vague prompts produce vague results.
- Spawn an explore agent first to understand the codebase, then spawn build agents with that context.
- Use `worktree: false` for read-only agents (research, review, code analysis).
- Use `plan_approval: true` for risky changes. The teammate sends a plan first, you review and approve before they write any code.
- Don't micromanage. Teammates message you when done or when they're blocked.
- Don't poll `team_status` in a loop. Wait for messages.

## Known limitations

- **Teammate messages may switch the lead's agent mode.** When a teammate sends a message back to the lead via `promptAsync`, OpenCode starts a new prompt loop that can switch the lead from plan/explore mode into build mode. This is a server-level behavior that the plugin cannot override. The lead's mode will restore when you send your next message.

## How this differs from Claude Code agent teams

Same coordination model (shared tasks, peer messaging, lead coordination) with some additions:

- **Git worktree isolation by default**: each teammate gets their own branch, no merge conflicts between parallel agents
- **System prompt injection**: the lead's system prompt is updated with team state so it stays aware across turns
- **Compaction safety**: team context is preserved when sessions get long
- **Team-aware shell environment**: `ENSEMBLE_TEAM`, `ENSEMBLE_MEMBER`, `ENSEMBLE_ROLE`, `ENSEMBLE_BRANCH`
- **Graceful shutdown**: teammates finish current work before stopping, with a force flag for emergencies
- **Plan approval mode**: review teammate plans before they write code
- **Works today as a plugin**: install and go, no upstream changes needed

## Development

```bash
bun install
bun run typecheck
bun test             # 286 tests
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
