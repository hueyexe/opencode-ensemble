# opencode-ensemble

Agent teams for [OpenCode](https://opencode.ai). Multiple agents running in parallel with peer-to-peer communication, shared task management, and coordinated execution.

Built as a plugin using the public OpenCode SDK — no internal dependencies.

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

## How It Works

A **lead** agent creates a team and spawns **teammates** — each teammate runs in its own OpenCode session, working in parallel. Agents communicate through direct messages and broadcasts, coordinate via a shared task board, and the lead manages the team lifecycle.

```
Lead Session                    Teammate Sessions
┌──────────────┐               ┌──────────────┐
│  team_create │               │   alice       │
│  team_spawn  │──promptAsync──│   (build)     │
│  team_spawn  │──promptAsync──│              │
│              │               ├──────────────┤
│  ◄───────────│──team_message─│   bob         │
│  team_message│──promptAsync──│   (explore)   │
│  team_shutdown│              │              │
│  team_cleanup│               └──────────────┘
└──────────────┘
```

All state lives in SQLite. Messages are delivered via `promptAsync` — a single atomic operation that injects a message and starts the prompt loop if idle.

## Tools

The plugin registers 11 tools:

| Tool | Who | What |
|------|-----|------|
| `team_create` | Any | Create a team, caller becomes lead |
| `team_spawn` | Lead | Spawn a teammate with a prompt |
| `team_message` | Any member | Send a message to a teammate or lead |
| `team_broadcast` | Any member | Message all team members |
| `team_tasks_list` | Any member | View the shared task board |
| `team_tasks_add` | Any member | Add tasks to the board |
| `team_tasks_complete` | Any member | Mark a task done, unblock dependents |
| `team_claim` | Any member | Atomically claim a pending task |
| `team_approve_plan` | Lead | Approve or reject a teammate's plan |
| `team_shutdown` | Lead | Request a teammate to stop |
| `team_cleanup` | Lead | Archive the team and free resources |

## Usage Example

Once installed, the lead agent can use team tools naturally:

```
User: Refactor the auth module and update the tests in parallel.

Agent (lead):
1. team_create({ name: "auth-refactor" })
2. team_spawn({ name: "alice", agent: "build", prompt: "Refactor src/auth/ to use JWT..." })
3. team_spawn({ name: "bob", agent: "build", prompt: "Update test/auth/ to match..." })
4. [waits for messages from teammates]
5. team_shutdown({ member: "alice" })
6. team_shutdown({ member: "bob" })
7. team_cleanup({ force: false })
```

Teammates communicate back to the lead and to each other:

```
alice: team_message({ to: "lead", text: "Refactoring complete. Changed 12 files." })
bob:   team_message({ to: "alice", text: "What's the new token format?" })
alice: team_message({ to: "bob", text: "JWT with RS256, see src/auth/token.ts" })
bob:   team_message({ to: "lead", text: "Tests updated and passing." })
```

## Configuration

### Rate Limiting

Control how many concurrent tool calls can execute per second. Useful when running multiple agents through a single gateway.

```bash
# Set capacity (default: 10 tokens, refills 2/sec)
OPENCODE_ENSEMBLE_RATE_LIMIT=20

# Disable rate limiting
OPENCODE_ENSEMBLE_RATE_LIMIT=0
```

## Architecture

- **Storage**: SQLite via `bun:sqlite` (WAL mode). Four tables: `team`, `team_member`, `team_task`, `team_message`.
- **Message delivery**: `client.session.promptAsync()` — fire-and-forget, queues if session is busy.
- **State machines**: Two-level per member (member status + execution status), driven by `session.status` events.
- **Sub-agent isolation**: `tool.execute.before` hook walks the parent chain to block team tools for sub-agents at arbitrary depth.
- **Recovery**: On plugin init, stale busy members are marked as error. Undelivered messages are redelivered via `promptAsync`.

See [AGENTS.md](./AGENTS.md) for the full architectural reference.

## Development

```bash
bun install
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
bun run build        # Bundle to dist/
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
