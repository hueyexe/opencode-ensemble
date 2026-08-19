# Swarm Phase 1 — Spike Findings

Throwaway spike. Real orchestrator moves to a `swarm/` package in the
opencode-ensemble monorepo (open source, per 2026-08-17).

## Environment (settled)

- **Temporal**: local Docker Compose, Postgres-backed. `temporalio/auto-setup:1.29.1`
  + `postgres:16` + `temporalio/ui`. Compose source: `/tmp/temporal-docker`
  (`docker-compose-postgres.yml`).
- **Connect at `127.0.0.1:7233`** (gRPC), UI at `http://127.0.0.1:8080`.
  Namespace: `default`.
- **PITFALL**: `temporal` CLI + SDK must use `127.0.0.1`, NOT `localhost` —
  `localhost` resolves to `::1` and hangs (Docker IPv6 port-mapping quirk).
  `TEMPORAL_ADDRESS=127.0.0.1:7233`.

## Finding 1 — Temporal TS SDK runs under Bun ✅ (2026-08-16)

- SDK `@temporalio/{client,worker,workflow,activity}@1.22.0` via `bun add`.
- `@temporalio/core-bridge` ships prebuilt `.node` binaries (linux-x64); no build.
- Workflow bundle produced by **webpack 5** (not esbuild) — non-issue.
- Bun logs `v8.promiseHooks.createHook is not available` → stack-trace collection
  disabled; non-fatal.
- **Orchestrator can be TypeScript + Bun.**

## Finding 2 — Swarm spine works end-to-end ✅ (2026-08-16)

Proved against local Temporal, `swarm-tasks` queue:

- `swarmRunWorkflow` (parent) → N `agentWorkflow` children in parallel.
- Per-agent lifecycle: `spawnAgent` → `pollAgent` (heartbeat) → `judge`.
- Cost aggregation: per-agent `cost` summed into `totalCost`.
- Budget cap: estimated-cost check throws before spawn if over budget.
- **Kill-all**: `killAll` signal → parent cancels children → children report
  `aborted`; total cost confirms they were stopped mid-flight.

### Pitfalls hit (real bugs, fixed)

1. `startChild()` returns `Promise<ChildWorkflowHandle>` — MUST
   `await Promise.all(...)` before calling `.result()`.
2. `ChildWorkflowHandle` has **no `.cancel()`** — cancel a child via
   `getExternalWorkflowHandle(h.workflowId).cancel()`.
3. Child workflows swallow cancellation unless detected:
   `catch (e) { status = isCancellation(e) ? 'aborted' : 'failed' }`.
4. Stub activities using `setTimeout` can't be interrupted by cancellation
   ("Activity not found on completion" warnings). Real activities must abort
   their HTTP calls on cancellation (AbortSignal).

## Finding 3 — opencode serve headless drive ✅ (2026-08-17)

Live-verified against `opencode serve` v1.18.16 (`--pure --port 4242`; auth =
HTTP basic, arbitrary username, password = `OPENCODE_SERVER_PASSWORD`).

### Endpoints that matter (v1 vs v2 skew — use the right one per op)

| Operation | Endpoint | Notes |
|---|---|---|
| Create session | `POST /api/session` (v2) | body `{model:{providerID,id}, location:{directory}}` → `{data:{id,cost,tokens,…}}` |
| Fire-and-forget prompt | `POST /session/{id}/prompt_async` (v1) | 204; body `{parts, format, …}` |
| Sync message (returns result inline) | `POST /session/{id}/message` (v1) | 200; body `{parts, format, …}` |
| Abort | `POST /session/{id}/abort` (v1) | also `DELETE /api/session/{id}`, `POST /api/session/{id}/interrupt` (spec'd, not yet live-tested) |
| Cost/tokens | `GET /api/session/{id}` → `data.cost`, `data.tokens` | per-session cumulative |
| Wait | `POST /api/session/{id}/wait` (v2) | blocks until done (spec'd) |

### Structured outputs (REQUIRED by Chris — every model call)

- Request: `format: {type:"json_schema", schema:<JSONSchema>, retryCount:N}`.
- Result comes back at **`info.structured`** (parsed JSON matching the schema).
  Verified: returned `{"word":"GO"}` exactly.
- Implemented as a `StructuredOutput` tool call (`finish:"tool-calls"`,
  `parts[].tool:"StructuredOutput"`).
- Per-message telemetry: `info.cost`, `info.tokens` (total/input/output/
  reasoning/cache).
- **Skew note**: v1 `GET /session/{id}/message` (list) 400s on the structured
  `format` round-trip — the sync POST is the reliable read path.

### Zero-cost test models

- `opencode` provider (OpenCode Zen) ships `$0` models: `deepseek-v4-flash-free`,
  `nemotron-3.5-lightning-free`, `ling-3.0-tiny-free`, … Use for smoke tests.
- Observed free turn: ~32K input tokens (system prompt + tool schemas), cost $0.
  Matches the plan's ~33K baseline.

### Swarm activity mapping

- `spawnAgent` → `POST /api/session` + `POST /session/{id}/prompt_async` (fire-and-forget, structured `format`)
- `pollAgent` → `GET /api/session/{id}` (tokens/time) or `/api/session/{id}/wait`
- `judge` → `POST /session/{id}/message` (sync, structured) → read `info.structured` + `info.cost`
- `abortAgent` → `POST /session/{id}/abort`

## Finding 4 — real activities wired, swarm runs on live models ✅ (2026-08-17)

Replaced stub activities with real HTTP calls to `opencode serve` (basic auth,
`fetch`). Full swarm ran end-to-end: 3 agents → spawn (create session +
`prompt_async` structured) → poll (heartbeat; `tokens.output > 0` = done) →
judge (sync structured message → `info.structured`). All 3 completed, judge
returned `accept` with detailed reasoning. Total cost $0 (free model).

- **Structured outputs confirmed in the real flow** — agent returns
  `{done, summary}`, judge returns `{verdict:"accept"|"reject", reason}`,
  read back from `info.structured`.
- **Cost accounting** works: cumulative session cost from `data.cost` +
  per-message `info.cost` on the judge call.
- **Poll heuristic**: `data.tokens.output > 0` = done (valid for single-turn
  structured agents). Real system should use `/api/session/{id}/wait` or SSE
  events for robust multi-turn detection.
- **Not yet live-tested**: `abort` (kill-all with real agents), branch
  preservation at the serve level, and multi-instance fleet management.

## Finding 5 — kill-all with real agents ✅ (2026-08-17)

- `POST /session/{id}/abort` verified live: 200 `true`, stops generation, session
  leaves `active`.
- Kill-all now aborts serve sessions (not just Temporal children): child workflow
  catches cancellation → `CancellationScope.nonCancellable(() => abortAgent(sid))`
  → returns `aborted`.
- Live test: 4 real agents killed at 4s → all `aborted`, `active` sessions empty,
  each killed session's `output_tokens = 0` (aborted before generating output).
  **No orphan sessions/processes.** The no-runaway guarantee holds.
- **Isolation finding**: `opencode serve` uses Chris's GLOBAL session store (50
  sessions incl. real work). The swarm fleet MUST use isolated state per serve
  instance (dedicated data dir / sandbox), or swarm sessions pollute the user's
  real session history.

## Finding 6 — 20-agent scale test ✅ (2026-08-17)

- 20 agents on free `deepseek-v4-flash-free` → **25.0s elapsed, totalCost $0**.
- 19 completed, 1 "failed" — the failure was the judge correctly REJECTING an
  agent that violated the reporting schema ("failed to follow the required
  reporting schema"). The structured-output + judge safety net works:
  non-conforming agents get rejected, not silently accepted.
- No rate-limit failures at 20 concurrent (free model handled it).
- Still a single serve instance (not yet a fleet).

## Finding 8 — multi-instance fleet + isolation ✅ (2026-08-17)

- `XDG_DATA_HOME` isolates opencode's session store: isolated instance had 0
  sessions vs 50 on the global instance.
- Fleet round-robin: activities round-robin `spawnAgent` across `OPENCODE_SERVERS`
  (comma-separated); each `SessionHandle` carries its `server` so poll/judge/
  abort stick to the right instance.
- Live test: 20 agents across 2 isolated instances → 20/20 completed, 25.3s, $0,
  distribution 10 + 10 (perfect round-robin).
- Note: `XDG_DATA_HOME` also isolates AUTH, so isolated instances can use free
  public models but not cloudflare/kiro credentials unless injected. Real system
  must mount/inject user auth per fleet instance.

## Finding 9 — swarmctl CLI ✅ (2026-08-17)

- Minimal `swarmctl` built on the Temporal client: `run`, `status`, `kill-all`.
- `run [task...]` → starts a swarm, waits, prints elapsed + cost + status counts.
- `status <wfId>` → workflow status (e.g. `COMPLETED`).
- `kill-all <wfId>` → sends killAll signal (verified: aborts in-flight agents).
- Real swarmctl adds pause/resume/msg (signals) + a `cost` query for running
  swarms (needs a workflow query handler).

## Finding 10 — Docker Sandboxes (sbx) verified ✅ (2026-08-18)

- Install: apt `docker-sbx` v0.38.0 (needs Docker apt repo + `kvm` group). CLI is
  a standalone `sbx` binary, NOT `docker sbx`. KVM was already present in WSL.
- `sbx daemon start` runs in foreground (run in background). `sbx policy init
  balanced` required before create. `sbx login` (Docker Hub identity, free)
  required to pull sandbox images.
- `sbx create shell <workspace>` → microVM, workspace bind-mounted at the SAME
  host path; agent runs as `agent` (UID 1000, not host user).
- Isolation VERIFIED:
  - Filesystem: own `/home` + `/etc/passwd`; host user/repos/SSH keys invisible;
    only the mounted workspace is accessible.
  - Network: internet egress OK (balanced policy); sandbox loopback is ISOLATED
    (cannot reach host's `127.0.0.1` services).
- `sbx create opencode` is the native agent type for the swarm fleet.
- `sbx exec` mirrors `docker exec` (COMMAND run directly; use `sh -c '...'`).

## Finding 11 — opencode in sandbox + network policy ✅ (2026-08-18)

- `sbx create opencode <workspace>` provisions opencode v1.18.13 + Node 22 inside
  the microVM (no auth inside — isolated like `XDG_DATA_HOME`).
- Network policy defaults to deny: model call to `opencode.ai:443` was BLOCKED
  ("Blocked by network policy: domain opencode.ai:443").
- Fix: `sbx policy allow network 'opencode.ai,*.opencode.ai'` → model call
  succeeded (free `deepseek-v4-flash-free` returned "PONG").
- Complete containment story: microVM fs/network/user isolation + default-deny
  egress + explicit allow for model APIs only.

## Finding 12 — swarm/ package + control-plane ✅ (2026-08-18)

- Migrated spike → `swarm/` package (own package.json + Temporal deps, strict
  tsconfig, README, docs/findings.md, examples/). Plugin stays zero-dep. Typecheck
  passing.
- swarmctl extended: `run` / `status` (live query) / `pause` / `resume` / `msg` /
  `kill-all`.
- Control-plane VERIFIED live: `status` query returns live state (agentCount,
  finished results, cost, paused/killed/messages); `pause`/`resume` flip a flag
  gated by the child poll loop via `condition(() => !paused)`; `msg` routes to an
  agent or broadcast and logs it. Children report completion via `agentDoneSignal`
  (parent located via `workflowInfo().parent`).

## Finding 13 — free-model drift: deepseek-v4-flash-free broke structured output (2026-08-18)

- `deepseek-v4-flash-free` (opencode provider) now runs in "thinking mode" and
  rejects structured output's tool_choice:
  `AI_APICallError: [invalid_request_error] Thinking mode does not support this tool_choice`.
  Symptom: serve 500s + agents never produce output (poll timeout → all failed).
- Fix: switch default model to `nemotron-3.5-lightning-free` (supports structured
  output). `ling-3.0-tiny-free` also fails (output 0).
- Lesson: free models drift; pin the model and re-verify structured output after
  provider changes.

## Finding 14 — sandboxed fleet + reliable kill-all teardown ✅ (2026-08-18)

- Containment proven adversarially: escape battery in a live microVM showed host
  fs/ssh/`/mnt/c`/process all unreachable; only the workspace is mounted
  (`rw,nosuid,nodev`); only `opencode.ai` egress allowed (webhook.site → 403).
- Sandboxed serve: `opencode serve` INSIDE the microVM, bound to `0.0.0.0`
  (`--hostname`), published via `--publish`; reachable from host; structured
  model call works through the published port.
- Fleet wired contained-by-default: `spawnAgent` provisions a microVM per agent;
  teardown on completion/failure/abort. `OPENCODE_SBX=0` falls back to plain fleet.
- Pitfalls hit + fixed:
  - `sbx exec` kills backgrounded processes → run the serve as a persistent exec child.
  - serve must bind `0.0.0.0` (`--hostname 0.0.0.0`) or the published port can't reach it.
  - activity `startToCloseTimeout` 1m was too short for provisioning → 5m.
  - cancellation must throw `CancelledFailure`, not `Error`, or Temporal retries forever.
  - sandbox name must be unique per workflow + idempotent (rm before create).
  - split provision/session so the child records its sandbox before the session
    step (else kill-all mid-session leaks the microVM).
- Verified: 2/2 completion + teardown; kill-all → 3/3 aborted with zero orphan VMs.

## Finding 15 — scale ceiling: structured-output concurrency (2026-08-18)

- Scale ramp (shared sandbox, free `nemotron-3.5-lightning-free`):
  - 3 agents → 3/3 ✅ (~110s)
  - 5 agents → 4/5 ✅ (~106s)
  - 7 agents → 0/7 ❌ (all poll-timeout — no output)
  - 10 agents → 0/10 ❌ (all poll-timeout)
- Direct model check: 7 concurrent PLAIN "PONG" calls → 7/7 OK. The model itself
  handles 7 concurrent; the cliff is in the STRUCTURED-output path
  (`json_schema` tool-calling), which stalls beyond ~5-6 concurrent.
- Bumping the shared sandbox to 2 CPU / 2 GiB did not help → not a resource bound.
- Conclusion: free-model structured-output concurrency is the ceiling (~5-6).
  The swarm ORCHESTRATION scaled fine to 10 children (all provisioned + polled);
  the model call is the bottleneck, not Temporal or the sandbox.
- Next fix: a concurrency limiter (cap concurrent agent model calls at ~5) or a
  higher-concurrency model/provider.

## Finding 16 — multi-serve fan-out; ceiling = free-model rate limit (2026-08-18)

- Refactor: ONE sandbox runs N serve instances (each its own concurrency domain)
  + round-robin across M models (`OPENCODE_MODELS`). Fan-out lever = serves × models.
- Verified endpoints: `opencode/nemotron-3.5-lightning-free` (free),
  `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`,
  `kiro-openai/gpt-5.6-luna`.
- Results: 1 serve/3 models/12 agents → 4/12; 3 serves/3 models/20 agents → 7/20.
  Bumping the sandbox 2→4 CPU + 2→4 GiB did NOT change 7/20 → not a resource bound.
- Conclusion: swarm + containment scale fine (20 agents in one sandbox); the
  ceiling is the free/cheap model APIs' rate limits (~7 concurrent structured calls
  across the fan-out). "Hundreds" needs higher-limit endpoints (paid / self-hosted
  Ollama / many keys), NOT more sandboxes.

## Finding 17 — Cloudflare is per-MINUTE (not per-request concurrency); JSON mode is 1 req (2026-08-18)

- Direct Cloudflare Workers AI REST test (deepseek-v4-flash-0731):
  - 10 concurrent → 10/10 OK (1.9s)
  - 20 concurrent → 8 OK + 10×429
  - 40 concurrent → 20 OK + 20×429
  - Error: `AiError: rate limiting: inference request per min rate reached` (code 3021).
- Conclusion: Cloudflare Workers AI limits **requests per minute** (~20/min on this
  account), NOT concurrent requests. The swarm's structured output (tool-calling
  round-trip ×2) + judge (×2) ≈ 4–6 model requests/agent, so 20 agents ≈ 100
  requests vs a ~20/min budget → most 429 → poll-timeout stalls.
- Native JSON mode confirmed working: `response_format: {type:'json_object'}` returns
  valid JSON in ONE request (vs tool-calling's 2+). Cutting requests/agent ~2× is a
  code-level lever.
- Scaling levers: (1) native JSON mode instead of tool-calling; (2) request a higher
  per-minute limit from Cloudflare (paid); (3) fan out across accounts/keys.

## Finding 18 — native JSON-schema mode (direct API, 1 request) (2026-08-18)

- opencode serve only accepts `format: {type:'text'|'json_schema'}`; `{type:'json'}`
  → 400. So "native JSON mode" can't be requested through the serve.
- Cloudflare Workers AI supports NATIVE `response_format: json_schema` (full schema)
  directly — 1 request, schema-enforced. Same for OpenRouter (OpenAI-compatible).
- Built `swarm/src/native.ts`: `nativeStructured(model, prompt, schema)` calls the
  provider's REST API directly with native `response_format` (Cloudflare + OpenRouter),
  reads auth from opencode's `auth.json`, and parses the JSON (fence/prose tolerant).
- Smoke (15 concurrent Cloudflare): 10 OK + 5 timeout (per-minute budget, not code).
- Wiring note: the judge's `json_schema` currently relies on the serve's session
  context; to use native mode the agent summary must be captured at spawn (session
  GET doesn't expose structured output, and `/messages` isn't a REST route).

## Finding 19 — native judge wired; kiro removed; config simplified (2026-08-19)

- Removed `kiro-openai/gpt-5.6-luna` from defaults (user's personal AWS hack, not a
  public endpoint). Defaults are now the two working endpoints: opencode free +
  Cloudflare DeepSeek V4 Flash.
- Wired `native.ts` into the judge: `spawnAgent` now runs the agent synchronously
  (`/message`, captures the structured summary + model); `judge` uses native
  `response_format: json_schema` (1 request) when the provider supports it, else
  falls back to opencode's session judge. 4/4 smoke passed.
- OpenRouter DeepSeek verified (`openrouter/deepseek/deepseek-v4-flash-latest` and
  `deepseek/deepseek-chat`) but the stored key is invalid (401 "User not found") —
  it's a bring-your-own-key option, not a default.
- Config is now trivial: `OPENCODE_MODELS="providerID,id|providerID,id|..."`, one or
  many or a mixture, auth reuses opencode's `auth.json` (no swarm-managed keys).

## Finding 20 — all providers route through opencode (native.ts removed) (2026-08-19)

- Reverted the `native.ts` direct-API layer: every provider flows through opencode's
  own provider abstraction (`opencode serve` + `format: json_schema`). A parallel
  provider path in the swarm would duplicate opencode's provider/auth/API work and
  grow unbounded as providers are added.
- The native `response_format` optimization (1 request vs tool-calling) belongs
  upstream in opencode's provider, not in the swarm. If a provider's structured
  output is request-hungry, that's an opencode concern.
- Net: swarm is back to opencode-only; the multi-serve + multi-model fan-out
  (`OPENCODE_MODELS`) and kiro removal remain.

## Finding 21 — graceful wave-based limiter; request multiplier (2026-08-19)

- Added `OPENCODE_SWARM_CONCURRENCY` (default 5): the parent spawns agents in WAVES
  of this size instead of firing all N at once, so the swarm queues work rather than
  rate-limit-stalling the whole fleet. Verified: 6 agents / concurrency 3 → two waves.
- Still saw stalls at concurrency 3 on a single serve: each agent costs 2+ model
  requests (opencode `json_schema` = tool-calling round-trip ×2 + judge ×2), so
  N agents ≈ 2N+ concurrent model calls — the effective per-serve ceiling (~4-5
  calls) is hit at ~2 agents, not ~5. Tune `OPENCODE_SWARM_CONCURRENCY` ~2 per serve
  (or more serves) to stay under it.
- Remaining gap: a stalled agent fails after the poll timeout instead of retrying.
  Graceful retry-on-stall (bounded backoff) is the next piece.

## Next

- Switch swarm structured output to native JSON mode (1 req) where supported, and/or
  add a per-endpoint request-budget limiter so agents queue instead of 429-stalling.
- Request a higher Cloudflare per-minute limit (account owner).
- Rogue-agent stress (dumb model via Ollama, or nemotron-based hung/garbage tests).
- Fold swarm into the plugin as the v2 "swarm" mode (Teams → Swarm).