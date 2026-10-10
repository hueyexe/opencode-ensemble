# Local-directory loading validation

## Scope

This verifies discovery and activation of the local Ensemble checkout, not full
compatibility of every team operation. Earlier unit-test results alone did not
prove local plugin installation worked.

## Confirmed cause

The installed OpenCode `v2.0.26` local `Host.resolve` calls `Bun.resolveSync`
for `<directory>/server` or `<directory>/index`, then `<directory>/tui` and
`<directory>/rpc`. With only `src/index.ts` and package exports, all three root
lookups failed. The configuration scanner omitted the plugin before setup.

The fix adds forwarding root entrypoints and includes them in published files.
The server implementation, TUI implementation, and RPC contract stay in `src/`.

## Verification performed

- `test/local-entrypoints.test.ts`: before implementation, 3 failed and 1
  passed; after implementation, 4 passed. It uses the same `Bun.resolveSync`
  root lookup as the installed host and checks that the server export is the
  existing dual-host plugin object.
- `bun run typecheck`, `bun test`, and `bun run build`: passed; full suite
  reported 868 passing tests and no failures.
- Real OpenCode server: separate HOME and XDG directories, separate database,
  loopback HTTP listener, and project under `/tmp/opencode`. No shared service
  restart, global configuration modification, or provider request was needed.
- Plugin activation was triggered with `POST /api/session` in the isolated
  project. `GET /api/plugin` then reported:

  ```json
  {
    "id": "ensemble",
    "source": { "type": "local", "path": "<checkout>/index.ts" },
    "features": { "server": true, "tui": true, "rpc": true },
    "state": { "status": "active" }
  }
  ```

- Dashboard `/api/health`, `/api/state`, and `/` returned HTTP 200; health
  reported `ensemble: true`. Dashboard HTML was returned, not merely a bound
  port. Missing root entrypoints are covered by the regression's RED run.
- Changing only the isolated project's dashboard setting to port `14747`
  and reloading that isolated location moved the dashboard successfully:
  `14747/api/health` returned HTTP 200 and the old `4747` listener closed.
  The user's shared OpenCode service was not restarted or stopped.

## Verification in the user's test project

After merging the correction into `feat/vfeitoza`, discovery was refreshed
through the test project's watched plugin directory (a temporary symlink was
created and then removed). The shared server was not restarted or stopped.
No symlink remains, and configuration still points to the original checkout.

`opencode plugin list` in `testes/01` now lists `ensemble` at the checkout's
`index.ts`. The API confirms exactly one Ensemble instance, with state `active`
and server/TUI/RPC features. The dashboard on port `4747` returned HTTP 200 for
health, state, and HTML. A fresh aggregate verification reported 868 passing
tests, zero failures, successful typecheck, and successful build.

## Not covered

- Terminal rendering and navigation of the TUI companion; discovery of its
  entrypoint is verified, but feature detection is not a rendering test.
- Effective permissions after switching to `explore`/`plan` on a host without
  `permission.rules`; the existing warning is not a replacement for enforcement.
- Worktree creation with the host's current `projectID` contract and session
  binding, model selection, messaging, shutdown, merge, and host inbox cleanup.
- Fable 5.1 review of this correction: pending. No subagent was dispatched,
  respecting the user's explicit no-subagent constraint.

**Runtime verdict:** local server activation and dashboard endpoints work as
specified in the isolated host. This is not a claim of 100% V2 compatibility.

## TUI team lookup correction

The terminal companion called `teamContext` without RPC `options.location`.
On the live host, the same lead session returned HTTP 400 `rpc.unavailable`
without location, while a request scoped to `testes/01` returned the active
`calculadora-custo-beneficio` team. The sidebar swallowed the failed request
and retained its empty initial state, displaying `Ensemble: no active team`.

`src/tui-context.ts` now resolves the displayed session's cached location,
then the companion location, then the client's default location. It supplies
that location as RPC call options, separate from the `sessionID` input.
The TUI delegates its sidebar fetch to this helper; server and web behavior
are unchanged.

- Regression: 4 failures and 1 passing test before implementation; 6 passing
  tests after implementation, including missing-session, actual no-team, and
  RPC failure cases.
- Full validation: typecheck and build passed; 874 tests passed, zero failed.
- The corrected helper was exercised against the live server using the
  existing lead session. It returned the team, 7 members, and 3 completed
  tasks. An unrelated session ID returned `team: null`, as expected.
- No server restart, team mutation, or global configuration change was needed.
- Terminal rendering has not been visually verified; the corrected fetch path
  is verified against the live RPC. Fable 5.1 review remains pending because
  no subagents were authorized.

## TUI open-task listing

The `teamContext` RPC now includes optional `openTasks` with task ID,
description, state, and nullable assignee. It selects only `pending`,
`in_progress`, and `blocked` rows scoped to the current team; the open counter
uses the same states and no longer includes cancelled rows. Making the new
field optional preserves compatibility with older companion/server contracts.

The sidebar renders `Tarefas abertas:` below member status, then each task's
description/state and `responsável`, falling back to `não atribuído`.
Existing counters and heartbeat behavior remain. With no open tasks, the
section is hidden rather than showing completed tasks as pending work.

Tests cover all open states, assignment, excluded completed/cancelled rows,
team isolation, unknown sessions, and all-open-work-completed behavior.
On the separate OpenCode host under `/tmp/opencode`, the real RPC returned
HTTP 200 with one pending unassigned task and counters `1 open / 1 done`,
excluding a cancelled task. A session outside the team returned an empty list.
No user team data was modified or shared server restarted. Visual terminal
rendering and Fable 5.1 review remain unverified/pending.
