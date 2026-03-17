# OpenCode Ensemble

Agent teams for [OpenCode](https://opencode.ai). Run multiple agents in parallel with messaging, shared tasks, and coordinated execution.

This is a plugin. It uses the public OpenCode SDK with zero internal dependencies. Install it, create a team, spawn teammates, and let them work together.

## What it does

You tell the lead agent what you want done. The lead breaks the work into pieces, spawns teammates, and coordinates them. Each teammate runs in its own session with its own context window. They communicate through direct messages and a shared task board.

```
You: "Refactor the auth module and update the tests."

Lead creates a team, spawns two teammates:
  alice (build) -> refactors src/auth/
  bob   (build) -> updates test/auth/

alice messages bob: "New token format is JWT with RS256, see src/auth/token.ts"
bob messages lead: "Tests updated and passing."
Lead shuts down both, cleans up the team.
```

The lead keeps you informed throughout. Toast notifications appear when teammates spawn, finish work, or hit errors. You can check team status at any time, or switch to a teammate's session to see exactly what they're doing.

## Install

```bash
bun add opencode-ensemble
```

Add to your OpenCode config (`.opencode/config.json`):

```json
{
  "plugins": {
    "ensemble": {
      "module": "opencode-ensemble"
    }
  }
}
```

Or for local development, drop a file in `.opencode/plugins/`:

```ts
export { default } from "opencode-ensemble"
```

## Tools

The plugin registers 13 tools. The lead agent has access to all of them. Teammates get a subset (no spawning, no shutdown, no cleanup).

**Team lifecycle**

| Tool | What it does |
|------|-------------|
| `team_create` | Create a team. Caller becomes the lead. |
| `team_spawn` | Start a new teammate with a task. |
| `team_shutdown` | Ask a teammate to stop. |
| `team_cleanup` | Remove the team after everyone is done. |

**Communication**

| Tool | What it does |
|------|-------------|
| `team_message` | Send a direct message to a teammate or the lead. |
| `team_broadcast` | Message everyone on the team. |

**Task board**

| Tool | What it does |
|------|-------------|
| `team_tasks_list` | See all tasks with status and assignee. |
| `team_tasks_add` | Add tasks to the shared board. |
| `team_tasks_complete` | Mark a task done. Unblocks dependents. |
| `team_claim` | Claim a pending task. Atomic, no double-claims. |

**Coordination**

| Tool | What it does |
|------|-------------|
| `team_approve_plan` | Approve or reject a teammate's plan before they write code. |
| `team_status` | See all members, their status, and a task summary. |
| `team_view` | Switch the TUI to a teammate's session to see their work. |

## How it works

**Storage**: SQLite via `bun:sqlite`. Four tables: teams, members, tasks, messages. WAL mode for concurrent access. Survives restarts.

**Messaging**: Messages go through `promptAsync`, which injects a user message into the recipient's session and starts their prompt loop if idle. One API call does both delivery and wake-up.

**Sub-agent isolation**: Teammates can spawn sub-agents (via the `task` tool), but those sub-agents cannot use team tools. The plugin tracks the full session parent chain and blocks team tool calls from any descendant session.

**Recovery**: If OpenCode restarts mid-session, the plugin scans for members stuck in "busy" status and marks them as errored. Undelivered messages are redelivered on startup.

**Rate limiting**: A token bucket controls how many concurrent tool calls can fire per second. Configurable via environment variable.

## Configuration

```bash
# Rate limit capacity (default: 10 tokens, refills 2/sec)
OPENCODE_ENSEMBLE_RATE_LIMIT=20

# Disable rate limiting entirely
OPENCODE_ENSEMBLE_RATE_LIMIT=0
```

## Limitations

This is a plugin, not a core feature. There are things it cannot do:

- **No persistent team panel in the TUI.** You get toast notifications and the `team_status` tool, but there's no always-visible sidebar showing member status. That requires changes to OpenCode's TUI itself. There are [open PRs](https://github.com/sst/opencode) working on native team support.

- **Teammate messages look like user messages.** When a teammate sends a message to the lead, it arrives as a `[Team message from alice]` text block. The TUI doesn't distinguish these from regular user input.

- **No custom UI components.** The plugin can show toasts, set tool titles, and navigate between sessions. It cannot render custom panels, buttons, or interactive elements.

If you need the full Claude Code-style team experience with a dedicated team panel and member cards, watch the upstream OpenCode PRs. This plugin provides the backend coordination that those PRs will eventually build a native UI on top of.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT
