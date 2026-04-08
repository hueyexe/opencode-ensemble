# opencode-ensemble — Agent Guidelines

## What This Is

opencode-ensemble is an OpenCode plugin that enables agent teams: multiple
agents running in parallel with peer-to-peer communication, shared task
management, and coordinated execution. Built entirely on the public OpenCode
plugin SDK (@opencode-ai/plugin) with zero internal dependencies.

## Architecture

### Plugin SDK Constraint

This is a plugin, not a core contribution. We only use APIs from
@opencode-ai/plugin and @opencode-ai/sdk. No access to OpenCode internals
(Storage, Bus, Lock, SessionPrompt, etc.).

Key SDK primitives:
- client.session.create() — create teammate sessions
- client.session.promptAsync() — inject messages + auto-wake (fire-and-forget)
- client.session.abort() — cancel/shutdown teammates
- client.session.status() — poll session idle/busy state
- event hook — subscribe to session.status events for state transitions
- tool hook — register the 13 team tools
- tool.execute.before hook — rate limiting + sub-agent isolation

### Storage

SQLite via bun:sqlite (zero dependencies). Four tables:
- team — team config (name, lead session, status, delegate mode)
- team_member — member registry (name, session ID, agent, status)
- team_task — shared task board (content, status, priority, assignee, deps)
- team_message — message log (from, to, content, delivered flag)

WAL mode. Migrations via PRAGMA user_version.

### Message Delivery

All messages delivered via client.session.promptAsync(). Single atomic
operation: injects user message + starts prompt loop if idle. No polling,
no file watching, no custom pub/sub.

### State Machines

Two-level per member:
- Member status: ready | busy | shutdown_requested | shutdown | error
- Execution status: idle | starting | running | cancel_requested |
  cancelling | cancelled | completing | completed | failed | timed_out

Driven by session.status events from the plugin event hook.

### Sub-Agent Isolation

Enforced via tool.execute.before hook. Maintains a Map<sessionID, parentSessionID>
populated from session events. When a team tool call arrives from an unknown
session, walks the parent chain (max depth 10). If any ancestor is a team
member, the call is blocked. This covers sub-agents at arbitrary depth.

## The 14 Tools

| Tool                | Who Can Use | Purpose                              |
|---------------------|-------------|--------------------------------------|
| team_create         | Any session | Create a new team, caller is lead    |
| team_spawn          | Lead only   | Spawn a teammate with a prompt (supports plan_approval mode) |
| team_message        | Any member  | Send message to teammate or lead (approve/reject plans) |
| team_broadcast      | Any member  | Send message to all team members     |
| team_tasks_list     | Any member  | View the shared team task board      |
| team_tasks_add      | Any member  | Add tasks to the shared board        |
| team_tasks_complete | Any member  | Mark a task complete, unblock deps   |
| team_claim          | Any member  | Atomically claim a pending task      |
| team_results        | Any member  | Retrieve full message content        |
| team_shutdown       | Lead only   | Request teammate shutdown, preserves branch |
| team_merge          | Lead only   | Merge a shutdown teammate's branch   |
| team_cleanup        | Lead only   | Archive team, safety-net merge remaining |
| team_status         | Any member  | View members, statuses, task summary |
| team_view           | Any member  | Navigate TUI to teammate's session   |

## Hooks

Three hooks wired in index.ts:

- `experimental.chat.system.transform` — injects team state into the lead's
  system prompt (member statuses, task counts, anti-polling guidance). Injects
  a short role reminder for teammates.
- `experimental.session.compacting` — preserves team context during session
  compaction so the model remembers it's leading/part of a team after long
  conversations are compressed.
- `shell.env` — sets ENSEMBLE_TEAM, ENSEMBLE_MEMBER, ENSEMBLE_ROLE, and
  ENSEMBLE_BRANCH in teammate shells.

## Settled Decisions (Do Not Re-Debate)

1. SQLite via bun:sqlite — not file JSON, not in-memory-only
2. promptAsync for message delivery — not session injection, not polling
3. 14 separate tools — not a unified action tool, no exceptions
4. Fire-and-forget spawn — not blocking, not tmux
5. tool.execute.before for rate limiting — token bucket, in-memory
6. tool.execute.before for sub-agent isolation — full descendant tracking via parent chain
7. Worktree isolation on by default — each teammate gets their own git
   worktree via client.worktree.create(). Opt out with worktree: false
   for read-only agents. Lead merges branches after cleanup.
8. Plan approval is prompt-enforced, not permission-based — the teammate's
   context message tells it to send a plan and wait for approval. No tool-level
   gating.
9. Graceful shutdown with manual force — team_shutdown requests graceful stop
   by default. Pass force: true to abort immediately.
10. Never await promptAsync — all promptAsync calls are fire-and-forget.
    Awaiting blocks the caller if the transport is slow or broken. Messages
    are persisted in the DB first; the idle-flush backstop handles delivery.
11. v1→v2 SDK transport extraction uses `._client` (underscore) — see
    "SDK Transport" section below. Do NOT change this property name.
12. Branch preservation before session.abort() is MANDATORY — see
    "Branch Preservation" section below. Every code path that calls
    session.abort() MUST preserve the worktree branch first.

## Branch Preservation (Critical — Do Not Skip)

`session.abort()` triggers OpenCode's internal session cleanup, which
asynchronously deletes the worktree AND its git branch. This is a race
condition — sometimes the branch survives, sometimes it doesn't.

### The invariant

**Every code path that calls `session.abort()` MUST call
`preserveBranch()` first.** No exceptions. This copies the worktree
branch to `ensemble/preserved/{team}/{name}`, a standalone git ref
that is not tied to any worktree. OpenCode cannot delete it.

### Call sites (audit these if you change shutdown/cleanup)

1. `team-shutdown.ts` → `preserveAndAbort()` — idle/force shutdown
2. `team-shutdown.ts` → graceful path — preserves before sending
   shutdown message (covers crash during shutdown_requested)
3. `team-cleanup.ts` → force-abort path — preserves before aborting
   active members

### What goes wrong if you skip it

The worktree branch is deleted by OpenCode's session cleanup. The
safety-net merge in `team_cleanup` finds no branch to merge. The
agent's committed work is permanently lost. This happened in v0.9.0
and earlier — agent work was silently destroyed on shutdown.

### How to verify

After any `session.abort()` call, check that the preserved branch
exists: `git branch --list ensemble/preserved/*`. If it's missing,
the preservation was skipped or failed.

## SDK Transport (Critical — Do Not Change)

The plugin framework provides a v1 SDK client (`input.client`). We need
the v2 SDK for flat params, `permission` on `session.create`, and `agent`
on `promptAsync`. The v2 client is created by extracting the HeyAPI
transport from the v1 client:

```typescript
const transport = (input.client as unknown as { _client: V2Transport })._client
const rawClient = new OpencodeClient({ client: transport })
```

### Why `_client` not `client`

The v1 SDK stores its HeyAPI transport as `this._client` (underscore).
The v2 SDK stores it as `this.client` (no underscore). These are
DIFFERENT property names on DIFFERENT classes.

- Reading FROM v1: `input.client._client` (underscore — v1 convention)
- Passing TO v2 constructor: `{ client: transport }` (no underscore — v2 param name)

### What goes wrong if you change this

- Using `.client` instead of `._client`: returns `undefined`, v2 falls
  back to a default HTTP transport that cannot reach the server (Unix
  socket, auth headers are missing). Every `session.create()` fails with
  "Unable to connect".
- Using `createOpencodeClient({ baseUrl })`: creates a standalone HTTP
  client. Same failure — the server may not be reachable via plain HTTP
  from inside a plugin.

### Biome compliance

The cast uses `as unknown as { _client: V2Transport }` — no `any` type.
The `V2Transport` type is inferred from the v2 `OpencodeClient`
constructor parameter. Biome's `noExplicitAny` rule is satisfied.

### How to verify

If `session.create()` returns "Unable to connect", the transport
extraction is broken. Check that `._client` is being read, not `.client`.

## promptAsync Is Fire-and-Forget (Critical — Do Not Await)

All `promptAsync` calls MUST be fire-and-forget (no `await`). This
applies to `team_spawn`, `team_message`, and `team_broadcast`.

### Why

`promptAsync` is HTTP 204 on the server (returns immediately, no body).
But if the transport is slow, the proxy buffers, or the connection has
latency, `await`ing it blocks the tool call. The lead's `team_spawn`
never returns, the TUI shows a loading spinner, and the lead hangs
indefinitely — even though the child session IS running.

### The pattern

```typescript
// CORRECT — fire-and-forget with async error handling
deps.client.session.promptAsync({ ... }).catch(() => { /* rollback */ })

// WRONG — blocks the caller
await deps.client.session.promptAsync({ ... })
```

### Safety net

Messages are persisted in the DB with `delivered=0` BEFORE the
`promptAsync` call. If delivery fails:
- team_spawn: async `.catch()` rolls back the member + notifies lead
- team_message: idle-flush backstop redelivers when recipient goes idle
- team_broadcast: partial delivery is expected and handled

## Lessons from Anthropic (Applied)

These are first-hand lessons from the Claude Code team that directly
apply to this plugin's design:

1. Separate tools beat unified action tools. A tool that does one
   thing has a clearer description, a tighter schema, and models
   call it more reliably. Do not consolidate tools to reduce count.

2. Teammates only see their tools. The context message injected by
   team_spawn should describe only the tools a teammate can use:
   team_message, team_broadcast, team_tasks_list, team_tasks_add,
   team_tasks_complete, team_claim. Do not describe lead-only tools
   to teammates.

3. Do not add periodic system reminders. Do not inject "remember
   your task" messages into teammate sessions on a timer or turn
   count. Trust the model to manage its own context. Reminders
   constrain rather than help capable models.

4. The task list is a coordination primitive, not a to-do list.
   Frame tasks as the way agents communicate work status to each
   other, not as a checklist for the individual agent.

5. If a feature can be implemented via a better prompt rather than
   a new tool, prefer the prompt. Every new tool is cognitive load.

## Teammate Context Message Design

The prompt injected by team_spawn is the teammate's entire world.
It must contain exactly:

1. Their name and role in the team
2. The task they are working on
3. The 6 tools they can use (team_message, team_broadcast,
   team_tasks_list, team_tasks_add, team_tasks_complete, team_claim)
   with a one-line description of each
4. How to report completion (team_message to lead with findings)
5. How to get unblocked (team_message to lead with the blocker)

Nothing else. No system architecture. No team history. No lead's
instructions beyond the task. Keep it under 500 tokens.

The lead's AGENTS.md and system prompt handle everything else.
Teammates do not need to know how agent teams work internally.

## Code Standards

- TypeScript strict mode
- Biome linter with `noExplicitAny: error` — no `any` types, no `as any` casts
- Zero external deps beyond @opencode-ai/sdk, @opencode-ai/plugin, bun:sqlite
- Every exported function has a JSDoc comment
- const over let, early returns over else
- snake_case for SQL columns, camelCase for TypeScript
- Functional array methods over for loops

## Build/Test Commands

- Install: `bun install`
- Typecheck: `bun run typecheck`
- Test: `bun test`
- Build: `bun run build`

## Before Marking Any Task Done

```
bun run typecheck && bun test && bun run build
```

All three must pass. Additionally:
- No TypeScript `any` types introduced
- No new `TODO` comments without a linked open question number (`OQ-<N>`)
- Test coverage for the happy path AND at least one error path per tool
- JSDoc on every exported function

## Bun Runtime

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile

## Publishing

Publishing is restricted to admin contributors (hueyexe). Do not publish
unless explicitly asked by the admin.

To publish a new version:

```
bun run typecheck && bun test && bun run build && bun publish --access public
```

Then create a GitHub release:

```
gh release create v<version> --repo hueyexe/opencode-ensemble --title "v<version>" --notes "<release notes>"
```

Use `gh auth switch --user hueyexe` first if the active gh account is not hueyexe.

### Release notes format

Every release MUST have a proper description. Do not use `--generate-notes`.
Follow this format:

- Main feature gets a `### Heading` describing what changed
- Bullet points for specific changes under the heading
- Secondary changes go under `### Also in this release` or `### Improvements`
- End with `**Full Changelog**: https://github.com/hueyexe/opencode-ensemble/compare/vPREV...vNEW`

Example:

```
### Git Worktree Isolation

Each teammate now gets their own git worktree by default.

- Worktree created automatically on `team_spawn` (opt out with `worktree: false`)
- Each teammate works on their own branch (`ensemble-{team}-{name}`)
- Orphaned worktrees cleaned up on plugin init

**Full Changelog**: https://github.com/hueyexe/opencode-ensemble/compare/v0.3.1...v0.4.0
```

## Testing

- bun test runs all tests
- In-memory SQLite (:memory:) — no disk, no cleanup
- Mock OpencodeClient for integration tests
- Race condition tests via Promise.all()
- No mocks for business logic

## TDD Workflow — Red/Green/Refactor

Every feature is built test-first. No exceptions.

### The cycle for each file:

1. RED: Write the test first. It must fail with a meaningful error,
   not a compile error. Run `bun test <file>` and confirm it fails.

2. GREEN: Write the minimum implementation to make the test pass.
   No gold-plating. Run `bun test <file>` and confirm it passes.

3. REFACTOR: Clean up the implementation without changing behaviour.
   Run `bun test <file>` again to confirm still green.

### Test file first

For every src/foo.ts, create test/foo.test.ts before writing
src/foo.ts. The test file is the specification.

### What "red" means

A test that throws "cannot find module" is not red — it is a
compile error. Write enough of the implementation file (empty
functions, correct signatures) to make it compile, then confirm
the test fails for the right reason before writing the real code.

### Never write a passing test first

If you write the implementation before the test, you will
rationalise the test around the implementation. Always test first.

### Spike exemption

For open questions (Section 9 of architecture plan), write a
spike test first that directly tests the unknown behaviour against
a real OpenCode server. The spike result determines the
implementation. Document the spike result in a comment.

## Open Question Handling

For open questions (Section 9 of .opencode/plans/architecture-plan.md):
- Make the conservative choice
- Add `// OQ-<number>: <assumption made>` comment at the call site
- Write a corresponding test that will fail if the assumption is wrong
- Do not silently resolve open questions without a comment

## Reference Material

docs/reference contains two PR implementations:
- opencode-pr-ugo/ — Event-driven, Storage-based (9 tools, auto-wake, inbox)
- opencode-pr-dxm/ — SQLite/Drizzle-based (unified action tool, blocking wait)

Both are core contributions importing OpenCode internals. Our plugin achieves
the same functionality using only the public SDK.

### Internal API Blocklist

When reading reference code, if you see any of these identifiers, they are
internal OpenCode APIs that we CANNOT use from a plugin:

- `Storage` (Storage.read, Storage.write, Storage.update, Storage.list)
- `Bus` (Bus.subscribe, Bus.publish)
- `Lock` (Lock.read, Lock.write)
- `SessionPrompt` (SessionPrompt.loop, SessionPrompt.cancel)
- `SessionStatus` (SessionStatus.get)
- `Identifier` (Identifier.ascending)
- `Instance` (Instance.project, Instance.directory)
- `Database` (Database.use)

Find the equivalent plugin SDK approach in
.opencode/plans/architecture-plan.md Section 1 (Gap Analysis table)
before proceeding.
