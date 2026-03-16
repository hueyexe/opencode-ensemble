# Contributing to opencode-ensemble

## Setup

```bash
git clone https://github.com/anomalyco/opencode-ensemble.git
cd opencode-ensemble
bun install
```

## Development Workflow

This project follows strict TDD (Red/Green/Refactor):

1. Write the test first in `test/`. It must fail for the right reason.
2. Write the minimum implementation in `src/` to make it pass.
3. Refactor without changing behavior. Confirm tests still pass.

Before submitting any change:

```bash
bun run typecheck && bun test && bun run build
```

All three must pass.

## Code Standards

- TypeScript strict mode — no `any` types
- Every exported function has a JSDoc comment
- `const` over `let`, early returns over `else`
- `snake_case` for SQL columns, `camelCase` for TypeScript
- Functional array methods over `for` loops
- Zero external dependencies beyond `@opencode-ai/sdk`, `@opencode-ai/plugin`, and `bun:sqlite`

## Testing

- All tests use in-memory SQLite (`:memory:`) — no disk I/O, no cleanup
- Mock `OpencodeClient` for integration tests (see `test/helpers.ts`)
- Race condition tests use `Promise.all()` / `Promise.allSettled()`
- No mocking of business logic — test actual SQLite transactions
- `bun test` is the only test runner

## Project Structure

```
src/
├── index.ts          # Plugin entry point
├── db.ts             # SQLite connection + init
├── schema.ts         # CREATE TABLE migrations
├── state.ts          # In-memory registry + descendant tracker
├── messaging.ts      # Message persistence + delivery helpers
├── recovery.ts       # Crash recovery (stale members + undelivered messages)
├── hooks.ts          # Event hook + sub-agent isolation
├── rate-limit.ts     # Token bucket rate limiter
├── types.ts          # Shared types + helper functions
├── util.ts           # ID generation + name validation
└── tools/            # One file per tool (11 total)

test/
├── helpers.ts        # Shared test utilities (setupDb, mockClient, etc.)
├── *.test.ts         # Unit tests for each src module
└── tools/            # Tool-specific tests
```

## Open Questions

Unresolved SDK behavior questions are tracked in `.opencode/plans/architecture-plan.md` Section 9. When you encounter one during implementation:

- Make the conservative choice
- Add `// OQ-<number>: <assumption made>` at the call site
- Write a test that will fail if the assumption is wrong

## Reference Material

The `docs/reference/` directory contains PR implementations from the OpenCode core repo. These use internal APIs (`Storage`, `Bus`, `Lock`, `SessionPrompt`, etc.) that are **not available** from a plugin. See the Internal API Blocklist in `AGENTS.md` before referencing them.
