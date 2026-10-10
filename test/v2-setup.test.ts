import { describe, expect, test } from "bun:test"
import { setupEnsemble, extractQuestionOutput, type V2SetupContext } from "../src/v2-setup"
/** Mock V2 setup context: hook registry + programmable event intake. */
function mockSetupCtx() {
  const hooks: Record<string, Array<(event: never) => unknown>> = {}
  const hook = (domain: string) => async (_name: string, cb: (event: never) => unknown) => {
    ;(hooks[domain] ??= []).push(cb)
    return { dispose: async () => undefined }
  }
  const ctx = {
    location: { directory: "/tmp/v2-setup-test" },
    options: {},
    session: {
      create: async () => ({ id: "ses_new" }),
      prompt: async () => ({ id: "msg_1" }),
      synthetic: async () => ({ id: "syn_1" }),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ id: "ses_x" }),
      context: async () => [],
      active: async () => ({}),
      hook: hook("session"),
    },
    permission: {
      rules: async () => undefined,
    },
    worktree: {
      create: async () => ({ directory: "/wt/x" }),
      remove: async () => undefined,
      list: async () => [],
      refresh: async () => undefined,
    },
    event: {
      subscribe: (_opts?: unknown) => {
        void _opts
        async function* stream(): AsyncGenerator<never> {
          // Tests drive events via handle.dispatch; the live loop drains this.
        }
        return stream()
      },
    },
    tool: {
      hook: hook("tool"),
      transform: async (_cb: (editor: never) => void) => ({ dispose: async () => undefined }),
    },
    shell: { hook: hook("shell") },
  }
  return { ctx: ctx as unknown as V2SetupContext, hooks }
}

function seedLeadAndMember(handle: Awaited<ReturnType<typeof setupEnsemble>>) {  const now = Date.now()
  handle.db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    ["team1", "alpha", "ses_lead", now, now],
  )
  handle.db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
    ["team1", "alice", "ses_alice", now, now],
  )
  handle.registry.register("team1", "alice", "ses_alice")
}

describe("v2-setup (issue #36)", () => {
  test("teamContext includes only this team's open tasks with assignment and state", async () => {
    const { ctx } = mockSetupCtx()
    let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}
    ctx.rpc = {
      register: async (_definition, registered) => {
        handlers = registered
        return { events: { emit: async () => undefined } }
      },
    }
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    try {
      seedLeadAndMember(handle)
      const tasks = [
        ["pending", "Greeting", null],
        ["in_progress", "Build", "alice"],
        ["blocked", "Review", null],
        ["completed", "Done", "alice"],
        ["cancelled", "Cancelled", null],
      ] as const
      tasks.forEach(([status, content, assignee], index) => handle.db.run(
        "INSERT INTO team_task (id,team_id,content,status,priority,assignee,time_created,time_updated) VALUES (?, 'team1', ?, ?, 'medium', ?, ?, ?)",
        [`task-${index}`, content, status, assignee, index, index],
      ))
      handle.db.run("INSERT INTO team(id,name,lead_session_id,status,delegate,time_created,time_updated) VALUES ('team2','other','ses-other','active',0,0,0)")
      handle.db.run("INSERT INTO team_task(id,team_id,content,status,priority,time_created,time_updated) VALUES ('foreign-task','team2','Other team work','pending','high',0,0)")
      const result = await handlers.teamContext?.({ sessionID: "ses_lead" }, {})
      expect(result).toMatchObject({
        tasks: { pending: 3, done: 1 },
        openTasks: [
          { id: "task-0", content: "Greeting", status: "pending", assignee: null },
          { id: "task-1", content: "Build", status: "in_progress", assignee: "alice" },
          { id: "task-2", content: "Review", status: "blocked", assignee: null },
        ],
      })
      expect(await handlers.teamContext?.({ sessionID: "ses-not-in-team" }, {})).toMatchObject({
        team: null, openTasks: [], tasks: { pending: 0, done: 0 },
      })
      handle.db.run("UPDATE team_task SET status='completed' WHERE team_id='team1' AND status IN ('pending','in_progress','blocked')")
      expect(await handlers.teamContext?.({ sessionID: "ses_lead" }, {})).toMatchObject({
        openTasks: [], tasks: { pending: 0, done: 4 },
      })
    } finally {
      await handle.dispose()
      handle.db.close()
    }
  })

  test("dispatched status events flow to member state", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_alice", status: "idle" } })
    const row = handle.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as {
      status: string
    }
    expect(row.status).toBe("ready")
    await handle.dispose()
  })

  test("tool execute.before blocks team tools for sub-agents", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.tracker.track("ses_child", "ses_alice")
    const before = hooks["tool"]?.[0]
    expect(before).toBeDefined()
    let blocked: unknown = null
    try {
      await before?.({
        tool: "team_message",
        sessionID: "ses_child",
        input: { to: "lead", text: "hi" },
      } as never)
    } catch (err) {
      blocked = err
    }
    expect(String(blocked)).toContain("sub-agents")
    await handle.dispose()
  })

  test("tool execute.after enriches shell arg-fumble errors (issue #39)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const after = hooks["tool"]?.[1]
    expect(after).toBeDefined()
    const original = 'Invalid arguments for tool "shell":\n- command: Missing key'
    const event = {
      tool: "shell",
      sessionID: "ses_alice",
      input: { cmd: "git remote -v 2>&1", description: "Check happy remotes again" },
      status: "error",
      error: { message: original },
    }
    await after?.(event as never)
    const message = (event.error as { message: string }).message
    expect(message).toContain(original)
    expect(message).toContain('"cmd"')
    expect(message).toContain('"command"')
    await handle.dispose()
  })

  test("tool execute.after leaves non-fumble errors untouched (issue #39)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const after = hooks["tool"]?.[1]
    const original = "Command timed out after 120000ms"
    const event = {
      tool: "shell",
      sessionID: "ses_alice",
      input: { command: "sleep 999" },
      status: "error",
      error: { message: original },
    }
    await after?.(event as never)
    expect((event.error as { message: string }).message).toBe(original)
    await handle.dispose()
  })

  test("shell hook is registered (per-session env unavailable on V2 — see OQ-V2-shell)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const shellHook = hooks["shell"]?.[0]
    expect(shellHook).toBeDefined()
    const event = { sessionID: "ses_lead", env: {} as Record<string, string | undefined> }
    await shellHook?.(event as never)
    expect(event.env["ENSEMBLE_TEAM"]).toBeUndefined()
    await handle.dispose()
  })

  test("session context hook appends team system prompt for team sessions", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const sessionHooks = hooks["session"] ?? []
    expect(sessionHooks.length).toBeGreaterThan(0)
    const contextHook = sessionHooks[0]
    const event = { sessionID: "ses_lead", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(event as never)
    expect(event.system.length).toBe(1)
    expect(event.system[0]?.text).toContain("alpha")
    // Member sessions get the Code Mode invocation hint; leads do not.
    const memberEvent = { sessionID: "ses_alice", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(memberEvent as never)
    expect(memberEvent.system.length).toBe(2)
    expect(memberEvent.system[1]?.text).toContain("execute")
    await handle.dispose()
  })

  test("dashboard serves team state on the configured port", async () => {    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 47999 })
    seedLeadAndMember(handle)
    const res = await fetch("http://localhost:47999/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ensemble?: boolean }
    expect(body.ensemble).toBe(true)
    const teams = (await (await fetch("http://localhost:47999/api/state")).json()) as {
      teams?: unknown[]
    }
    expect(teams.teams?.length).toBe(1)
    await handle.dispose()
  })

  test("extractQuestionOutput reads string and part-array results", () => {
    expect(extractQuestionOutput({ content: "Approve purge abc123" })).toBe("Approve purge abc123")
    expect(
      extractQuestionOutput({ content: [{ type: "text", text: "yes" }, { type: "other" }] }),
    ).toBe("yes")
    expect(extractQuestionOutput(undefined)).toBe("")
  })

  test("setup rehydrates registry and nudges already-idle silent members", async () => {
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dbPath = join(tmpdir(), `ensemble-rehydrate-${Date.now()}.db`)
    // Seed a file DB directly (simulates state from before a restart).
    const { createDb } = await import("../src/db")
    const seed = createDb(dbPath)
    const now = Date.now()
    seed.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
      ["team1", "alpha", "ses_lead", now, now],
    )
    seed.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      ["team1", "alice", "ses_alice", now, now],
    )
    seed.close()

    const prompts: unknown[] = []
    const { ctx } = mockSetupCtx()
    const session = ctx.session as unknown as {
      prompt: (input: unknown) => Promise<unknown>
    }
    session.prompt = async (input: unknown) => {
      prompts.push(input)
      return { id: "msg_1" }
    }
    const handle = await setupEnsemble(ctx, { dbPath, dashboardPort: 0 })
    // Registry rehydrated from SQLite despite the fresh process.
    expect(handle.registry.getBySession("ses_alice")?.memberName).toBe("alice")
    // Already-idle silent member got its one nudge on startup.
    const nudges = prompts.filter((p) => JSON.stringify(p).includes("did not report"))
    expect(nudges.length).toBe(1)
    expect(JSON.stringify(nudges[0])).toContain("ses_alice")
    await handle.dispose()
    // A second setup (hot-reload) must NOT nudge again within the hour.
    const prompts2: unknown[] = []
    const { ctx: ctxReload } = mockSetupCtx()
    const sessionReload = ctxReload.session as unknown as {
      prompt: (input: unknown) => Promise<unknown>
    }
    sessionReload.prompt = async (input: unknown) => {
      prompts2.push(input)
      return { id: "msg_1" }
    }
    const handle2 = await setupEnsemble(ctxReload, { dbPath, dashboardPort: 0 })
    expect(prompts2.filter((p) => JSON.stringify(p).includes("did not report")).length).toBe(0)
    await handle2.dispose()
    const { rm } = await import("node:fs/promises")
    await rm(dbPath, { force: true })
  })
})
