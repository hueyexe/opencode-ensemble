# opencode-ensemble-swarm

Swarm orchestration for OpenCode Ensemble: a Temporal-backed workflow spine that
drives a fleet of headless `opencode serve` instances, each running
structured-output agent sessions in isolated Docker Sandboxes.

> Phase 1 spike — verified end-to-end. See [docs/findings.md](docs/findings.md)
> for the full findings, API surface, and pitfalls.

## Architecture

| Layer | Role |
|---|---|
| Temporal | durable spine — parallel agent workflows, kill-all signal, budget cap, cost aggregation |
| `opencode serve` | headless agent execution — one or more instances = the fleet |
| Structured outputs | every model call uses JSON schema; results read from `info.structured` |
| Docker Sandboxes (`sbx`) | per-agent microVM isolation — filesystem, network, user |

## Quick start

```bash
# 1. Temporal (local, Docker) — use 127.0.0.1, never localhost
git clone --depth 1 https://github.com/temporalio/docker-compose.git /tmp/temporal-compose
cd /tmp/temporal-compose && docker compose -f docker-compose-postgres.yml up -d

# 2. opencode serve fleet (isolated per instance)
XDG_DATA_HOME=/tmp/swarm-a OPENCODE_SERVER_PASSWORD=swarm-test ~/.opencode/bin/opencode serve --port 4243 --pure &
XDG_DATA_HOME=/tmp/swarm-b OPENCODE_SERVER_PASSWORD=swarm-test ~/.opencode/bin/opencode serve --port 4244 --pure &

# 3. worker (wired to the fleet)
OPENCODE_SERVERS=http://127.0.0.1:4243,http://127.0.0.1:4244 \
OPENCODE_SERVER_PASSWORD=swarm-test bun run src/worker.ts

# 4. run a swarm
bun run src/cli.ts run "Summarize what X is in one sentence." "Summarize what Y is."
```

## Containment (Docker Sandboxes)

Agents run inside `sbx` microVMs with default-deny network egress:

```bash
sbx policy init balanced
sbx create opencode <workspace>            # --clone for a private worktree clone
sbx policy allow network 'opencode.ai,*.opencode.ai'   # model API is denied by default
```

Isolation verified: agent runs as `agent` (UID 1000); host user/repos/SSH keys
invisible; only the mounted workspace is reachable; sandbox loopback can't see
host services.

## License

MIT