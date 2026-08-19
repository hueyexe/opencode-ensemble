# opencode-ensemble-swarm

Swarm orchestration for OpenCode Ensemble: a Temporal-backed workflow spine that
drives a fleet of headless `opencode serve` instances — all inside **one** Docker
Sandbox — each running structured-output agent sessions. Fan out across **many
models/providers** to scale past any single provider's rate limit.

> Phase 1 spike — verified end-to-end. See [docs/findings.md](docs/findings.md)
> for the full findings, API surface, and pitfalls.

## Architecture

| Layer | Role |
|---|---|
| Temporal | durable spine — parallel agent workflows, kill-all signal, cost aggregation |
| `opencode serve` | headless agent execution — N instances inside one sandbox = the fleet |
| Structured outputs | JSON schema for every model call, via opencode's `format: json_schema` |
| Docker Sandboxes (`sbx`) | ONE microVM contains the whole swarm (host isolation) |

## Models — trivial to configure

Every model in opencode's provider pool is a valid endpoint. Pick one, or many, or
a mixture — the swarm round-robins across the list.

```bash
# one provider + one model
OPENCODE_MODELS="opencode,nemotron-3.5-lightning-free"

# many providers, same model (fan out to dodge per-account rate limits)
OPENCODE_MODELS="cloudflare-workers-ai,@cf/deepseek-ai/deepseek-v4-flash-0731|openrouter,deepseek/deepseek-chat"

# any mixture — different models, different providers
OPENCODE_MODELS="opencode,nemotron-3.5-lightning-free|cloudflare-workers-ai,@cf/deepseek-ai/deepseek-v4-flash-0731"
```

Format: `providerID,modelID` per entry, `|` between entries. Each provider's auth
comes from opencode's own `auth.json` (whatever the user has `opencode auth login`-ed)
— the swarm doesn't manage its own keys.

Defaults (when `OPENCODE_MODELS` is unset): `opencode/nemotron-3.5-lightning-free`
and `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`.

## Quick start

```bash
# 1. Temporal (local, Docker) — use 127.0.0.1, never localhost
git clone --depth 1 https://github.com/temporalio/docker-compose.git /tmp/temporal-compose
cd /tmp/temporal-compose && docker compose -f docker-compose-postgres.yml up -d

# 2. worker (provisions the sandbox + serve fleet itself; needs the kvm group)
sg kvm -c "OPENCODE_SERVER_PASSWORD=swarm-test bun run src/worker.ts"

# 3. run a swarm
bun run src/cli.ts run "Summarize what X is in one sentence." "Summarize what Y is."
```

## Containment (Docker Sandboxes)

The whole swarm runs inside a single `sbx` microVM with default-deny network egress
(model APIs are the only allowed destinations). Isolation verified: agents can't see
the host user/repos/SSH keys; only the mounted workspace is reachable; sandbox
loopback can't reach host services.

Resource bounds per sandbox (configurable): `OPENCODE_SBX_CPUS` (default 2),
`OPENCODE_SBX_MEM` (default 2g), `OPENCODE_SBX_SERVERS` (default 3 serve instances).

Graceful budget limiter: `OPENCODE_SWARM_CONCURRENCY` (default 5) — the swarm
spawns agents in waves of this size so it queues work instead of firing every agent
at once and rate-limit-stalling the whole provider. Lower it to stay under a tight
provider budget; raise it when you have more headroom.

Retry-on-stall: `OPENCODE_SWARM_RETRIES` (default 3) — an agent whose model call
stalls (rate-limit) is aborted and re-driven with bounded backoff (10s, 20s, 30s…)
instead of failing immediately. Each retry round-robins models, so it may land on a
different provider and clear the throttle.

Price control: `OPENCODE_SWARM_BUDGET` (default $5) caps total spend — the swarm
refuses to start if the upfront estimate exceeds it, and stops spawning further
waves mid-run once live cost crosses it. The estimate is `agents ×
OPENCODE_EST_COST_PER_AGENT` (default $0.002). Live spend, budget, and %-used are
visible via `swarmctl status`.

## License

MIT