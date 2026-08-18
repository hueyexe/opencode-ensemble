import { Context, CancelledFailure } from '@temporalio/activity';

const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? 'swarm-test';
// Fan-out: round-robin the swarm's agents across MULTIPLE model endpoints so no
// single provider's concurrency limit becomes the swarm's ceiling. Override with
// OPENCODE_MODELS="providerID,id|providerID,id|..." (comma splits provider/model,
// pipe splits entries).
const MODELS: { providerID: string; id: string }[] = (() => {
  const env = process.env.OPENCODE_MODELS;
  if (env) {
    return env
      .split('|')
      .map((s) => {
        const [providerID, id] = s.split(',');
        return { providerID: providerID ?? '', id: id ?? '' };
      })
      .filter((m) => m.providerID && m.id);
  }
  return [
    { providerID: 'opencode', id: 'nemotron-3.5-lightning-free' },
    { providerID: 'cloudflare-workers-ai', id: '@cf/deepseek-ai/deepseek-v4-flash-0731' },
    { providerID: 'kiro-openai', id: 'gpt-5.6-luna' },
  ];
})();
const WORKDIR = process.env.OPENCODE_WORKDIR ?? '/tmp/sbx-smoke';

// Sandboxed fleet (DEFAULT): each agent runs in its own sbx microVM hosting a
// headless opencode serve. Containment is the default; set OPENCODE_SBX=0 to
// fall back to a plain round-robin server fleet (no microVM isolation).
const SANDBOXED = process.env.OPENCODE_SBX !== '0';
const SBX = '/usr/bin/sbx';
const SBX_BASE_PORT = Number(process.env.OPENCODE_SBX_BASE_PORT ?? 4250);
// Per-microVM resource bounds so a fleet can't exhaust the host.
const SBX_CPUS = process.env.OPENCODE_SBX_CPUS ?? '2';
const SBX_MEM = process.env.OPENCODE_SBX_MEM ?? '2g';
// Number of serve instances inside the single sandbox. Each serve is its own
// concurrency domain (~4-5 structured calls), so this is the fan-out lever.
const SBX_SERVERS = Number(process.env.OPENCODE_SBX_SERVERS ?? '3');
const PLAIN_SERVERS = (process.env.OPENCODE_SERVERS ?? 'http://127.0.0.1:4242')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Structured-output schemas. REQUIRED: every model call uses json_schema.
const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['done', 'summary'],
  additionalProperties: false,
};

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

export interface SessionHandle {
  id: string;
  cost: number;
  server: string;
  sandbox?: string;
}

export interface PollResult {
  done: boolean;
  ok: boolean;
  cost: number;
}

export interface Verdict {
  verdict: 'accept' | 'reject';
  reason: string;
  cost: number;
}

let serverIndex = 0;
let sbxPort = 0;
let modelIndex = 0;

function pickModel(): { providerID: string; id: string } {
  const m = MODELS[modelIndex % MODELS.length] ?? MODELS[0]!;
  modelIndex += 1;
  return m;
}

function pickServer(servers: string[]): string {
  const s = servers[serverIndex % servers.length] ?? servers[0]!;
  serverIndex += 1;
  return s;
}

async function oc(method: string, server: string, path: string, body?: unknown): Promise<any> {
  const auth = btoa(`opencode:${PASSWORD}`);
  const res = await fetch(`${server}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`opencode ${method} ${server}${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Shell out to the sbx CLI. Requires the worker process to be in the `kvm` group
// (start it with `sg kvm -c "bun run src/worker.ts"`).
async function runSbx(args: string[]): Promise<void> {
  const proc = Bun.spawn([SBX, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`sbx ${args.join(' ')} (exit ${code}): ${err.slice(0, 200)}`);
}

async function waitHealthy(server: string): Promise<void> {
  const auth = btoa(`opencode:${PASSWORD}`);
  for (let i = 0; i < 120; i++) {
    if (Context.current().cancellationSignal.aborted) {
      throw new CancelledFailure('cancelled while waiting for serve');
    }
    try {
      const r = await fetch(`${server}/api/health`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`serve not healthy after 120s: ${server}`);
}

export interface Provision {
  sandbox: string | undefined;
  servers: string[];
}

// Provision the swarm's execution environment: ONE fresh microVM (default) running
// N serve instances (each its own concurrency domain), or the plain server list.
// Cancellation-aware: any failure/cancel tears down the microVM before rethrowing.
export async function provisionSandbox(): Promise<Provision> {
  if (SANDBOXED) {
    const wfId = Context.current().info.workflowExecution?.workflowId ?? 'unknown';
    const sandbox = `swarm-${wfId.replace(/^swarm-/, '')}`;
    try {
      // Idempotent create: drop any leftover microVM from a prior attempt first.
      try {
        await runSbx(['rm', '--force', sandbox]);
      } catch {
        // nothing to remove
      }
      const publishes: string[] = [];
      const servers: string[] = [];
      for (let i = 0; i < SBX_SERVERS; i++) {
        const hostPort = SBX_BASE_PORT + sbxPort++;
        const sandboxPort = 4243 + i;
        publishes.push('--publish', `${hostPort}:${sandboxPort}`);
        servers.push(`http://127.0.0.1:${hostPort}`);
      }
      await runSbx([
        'create', 'opencode', WORKDIR, '--name', sandbox,
        ...publishes, '--cpus', SBX_CPUS, '-m', SBX_MEM,
      ]);
      // One serve per sandbox port. Each sbx exec stays alive as a worker child;
      // sbx rm (on abort/teardown) severs them all.
      for (let i = 0; i < SBX_SERVERS; i++) {
        Bun.spawn(
          [
            SBX, 'exec', '-e', `OPENCODE_SERVER_PASSWORD=${PASSWORD}`, sandbox,
            'opencode', 'serve', '--port', String(4243 + i), '--hostname', '0.0.0.0',
            '--pure', '--log-level', 'ERROR',
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
      }
      for (const s of servers) {
        await waitHealthy(s);
      }
      return { sandbox, servers };
    } catch (e) {
      // Clean up the microVM on any failure (including cancellation).
      try {
        await runSbx(['rm', '--force', sandbox]);
      } catch {
        // best-effort
      }
      throw e;
    }
  }
  return { sandbox: undefined, servers: [...PLAIN_SERVERS] };
}

// Create a session on the (already-provisioned) server + fire-and-forget the task.
export async function spawnAgent(
  name: string,
  task: string,
  servers: string[],
): Promise<SessionHandle> {
  const server = pickServer(servers);
  const created = await oc('POST', server, '/api/session', {
    model: pickModel(),
    location: { directory: WORKDIR },
  });
  const id = created.data.id;
  await oc('POST', server, `/session/${id}/prompt_async`, {
    parts: [
      {
        type: 'text',
        text: `You are worker agent "${name}". Your task: ${task}\n\nDo the work and report the outcome using the required JSON schema.`,
      },
    ],
    format: { type: 'json_schema', schema: AGENT_SCHEMA, retryCount: 1 },
  });
  return { id, cost: created.data.cost ?? 0, server };
}

// Poll session status; heartbeat each poll so a hung agent trips the timeout.
export async function pollAgent(id: string, attempt: number, server: string): Promise<PollResult> {
  Context.current().heartbeat({ id, attempt, server });
  const s = await oc('GET', server, `/api/session/${id}`);
  const d = s.data ?? s;
  const done = (d.tokens?.output ?? 0) > 0;
  return { done, ok: true, cost: d.cost ?? 0 };
}

// Abort a session AND tear down its sandbox (no orphan microVMs). Real impl must
// preserve the worktree branch FIRST (invariant).
export async function abortAgent(
  id: string,
  server: string,
  sandbox?: string,
): Promise<{ cost: number }> {
  try {
    await oc('POST', server, `/session/${id}/abort`);
  } catch {
    // session may already be gone
  }
  if (sandbox) {
    try {
      await runSbx(['rm', '--force', sandbox]);
    } catch {
      // best-effort; a failed teardown leaves an orphan microVM (flag in real impl)
    }
  }
  return { cost: 0 };
}

// Sync judge call (structured) — returns the verdict inline.
export async function judge(name: string, sessionId: string, server: string): Promise<Verdict> {
  const m = await oc('POST', server, `/session/${sessionId}/message`, {
    parts: [
      {
        type: 'text',
        text: `You are the lead. Review worker agent "${name}"'s work above and return a verdict using the required JSON schema.`,
      },
    ],
    format: { type: 'json_schema', schema: JUDGE_SCHEMA, retryCount: 1 },
  });
  const structured = m.info?.structured ?? {};
  return {
    verdict: structured.verdict ?? 'reject',
    reason: structured.reason ?? 'no reason given',
    cost: m.info?.cost ?? 0,
  };
}

// Inject a user message into an agent's session (no structured output — a message).
export async function sendMessage(
  sessionId: string,
  server: string,
  text: string,
): Promise<{ cost: number }> {
  await oc('POST', server, `/session/${sessionId}/prompt_async`, {
    parts: [{ type: 'text', text }],
  });
  return { cost: 0 };
}

// Tear down an agent's microVM on completion/failure (abort uses abortAgent).
export async function teardownSandbox(sandbox: string): Promise<{ cost: number }> {
  try {
    await runSbx(['rm', '--force', sandbox]);
  } catch {
    // best-effort; a failure here leaves an orphan microVM (flag in real impl)
  }
  return { cost: 0 };
}