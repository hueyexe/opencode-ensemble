# OpenCode Ensemble

[![npm version](https://img.shields.io/npm/v/@hueyexe/opencode-ensemble.svg)](https://www.npmjs.com/package/@hueyexe/opencode-ensemble)
[![npm downloads](https://img.shields.io/npm/dm/@hueyexe/opencode-ensemble.svg)](https://www.npmjs.com/package/@hueyexe/opencode-ensemble)
[![tests](https://img.shields.io/badge/tests-452%20passing-brightgreen.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)]()
[![OpenCode SDK](https://img.shields.io/badge/deps-OpenCode%20SDK%20only-blue.svg)]()
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

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
    alice   [idle 2m, last msg: 1m ago]     agent: build  branch: ensemble-validation-alice
    bob     [idle 1m, last msg: 30s ago]     agent: build  branch: ensemble-validation-bob
    carol   [working 5m, last msg: 3m ago]   agent: build  branch: ensemble-validation-carol
      task: Write integration tests for validated endpoints
  Tasks: 5 total (3 completed, 1 in_progress, 1 pending)
```

Want to see what carol is doing? The lead can switch your view to her session:

```
You: "Show me what carol is working on."

Lead calls team_view({ member: "carol" })
-> TUI switches to carol's session, showing her full chat log
-> Use the session picker (ctrl+p) to go back to the lead
```

When everything is done, the lead shuts down teammates and cleans up. Worktree branches are automatically merged into your working directory as unstaged changes for review:

```
[toast] alice shut down
[toast] bob shut down
[toast] carol shut down

Lead: "All validation and tests are complete. 5 endpoints validated,
       12 test cases added. Team cleaned up.
       Merged 3 branch(es) into working directory (unstaged).
       Review changes with: git diff"
```

All teammate changes are now in your working directory, unstaged, ready for you to review file-by-file with `git diff`.

## Install

Two steps: add the plugin, then allowlist worktree paths.

### 1. Add the plugin

Add to your OpenCode config with a pinned version. Project-level or global.

**Project-level** (`opencode.json` in your project root):

```json
{
  "plugin": ["@hueyexe/opencode-ensemble@0.9.1"]
}
```

**Global** (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@hueyexe/opencode-ensemble@0.9.1"]
}
```

OpenCode auto-installs npm plugins at startup. To update, bump the version number in your config and restart OpenCode.

**Why pin versions?** OpenCode has a [known bug](https://github.com/anomalyco/opencode/issues/6774) where unpinned plugins (e.g., `"@hueyexe/opencode-ensemble"`) get cached on first install and never auto-update, even after restarting. Pinning to a specific version avoids this — when you change the version string, OpenCode sees a new package spec and installs it fresh.

If you're stuck on an old version, clear the cache manually:

```bash
rm -rf ~/.cache/opencode/packages/@hueyexe
```

Then restart OpenCode.

### 2. Allow worktree directory access

Teammates work in git worktrees outside your project directory. Without this permission, OpenCode will prompt you to approve every file operation in a teammate's worktree.

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "permission": {
    "external_directory": {
      "~/.local/share/opencode/worktree/**": "allow"
    }
  }
}
```

This is required. Without it, you'll see "Permission required — Access external directory" prompts constantly.

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

14 tools. The lead has all of them. Teammates get 6 (messaging + tasks).

**Team lifecycle** (lead only)

| Tool | What it does |
|------|-------------|
| `team_create` | Create a team. Caller becomes the lead. |
| `team_spawn` | Start a new teammate with a task. Supports `plan_approval` mode. |
| `team_shutdown` | Ask a teammate to stop. Preserves their branch before aborting. Supports `force` flag. |
| `team_merge` | Merge a shutdown teammate's branch into working directory (unstaged). |
| `team_cleanup` | Remove the team when done. Safety-net merges any forgotten branches. |
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
- **Stall detection**: detects teammates making no progress (low output tokens or no communication) and escalates to the lead
- **Auto-merge on cleanup**: worktree branches are squash-merged into your working directory as unstaged changes for review
- **Spawn circuit breaker**: stops retrying after 3 consecutive spawn failures
- **Graceful shutdown**: busy teammates receive a shutdown message and finish their current work. Use `force: true` to abort immediately.
- **Rate limiting**: token bucket (configurable via config file or `OPENCODE_ENSEMBLE_RATE_LIMIT`, default 10 tokens/sec)

## Configuration

Configure via JSON files, environment variables, or both. Project config overrides global config. Env vars override everything.

### Config file

**Global** (`~/.config/opencode/ensemble.json`):

```json
{
  "mergeOnCleanup": true,
  "stallThresholdMs": 180000,
  "stallMinSteps": 3,
  "stallTokenThreshold": 500,
  "timeoutMs": 1800000,
  "rateLimitCapacity": 10
}
```

**Project** (`.opencode/ensemble.json` in your project root) — same shape, overrides global per-key.

All fields are optional. Missing fields use defaults.

| Key | Default | Description |
|-----|---------|-------------|
| `mergeOnCleanup` | `true` | Auto-merge worktree branches on cleanup (squash + unstage) |
| `stallThresholdMs` | `180000` (3 min) | Time without communication before stall escalation. `0` disables. |
| `stallMinSteps` | `3` | Min model steps before token-based stall check kicks in |
| `stallTokenThreshold` | `500` | Output tokens per step below which the agent is considered stalled |
| `timeoutMs` | `1800000` (30 min) | Hard timeout for busy teammates. `0` disables. |
| `rateLimitCapacity` | `10` | Token bucket capacity for team tool calls. `0` disables. |

### Environment variables

Env vars override config file values. Useful for CI or one-off overrides.

```bash
# Adjust teammate timeout (default: 1800000ms = 30 minutes)
OPENCODE_ENSEMBLE_TIMEOUT=3600000

# Disable timeout watchdog
OPENCODE_ENSEMBLE_TIMEOUT=0

# Adjust rate limit (default: 10 tokens, refills 2/sec)
OPENCODE_ENSEMBLE_RATE_LIMIT=20

# Disable rate limiting
OPENCODE_ENSEMBLE_RATE_LIMIT=0

# Adjust stall detection threshold (default: 180000ms = 3 minutes)
STALL_THRESHOLD_MS=300000

# Disable stall detection
STALL_THRESHOLD_MS=0
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
bun test             # 452 tests
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
