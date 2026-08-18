import { Context } from '@temporalio/activity';

// Serve FLEET config (spike: round-robin across N instances). The real
// orchestrator manages fleet lifecycle (start/stop/health-check per instance).
const SERVERS = (process.env.OPENCODE_SERVERS ?? 'http://127.0.0.1:4242')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? 'swarm-test';
const MODEL = {
  providerID: process.env.OPENCODE_MODEL_PROVIDER ?? 'opencode',
  id: process.env.OPENCODE_MODEL_ID ?? 'deepseek-v4-flash-free',
};
const WORKDIR = process.env.OPENCODE_WORKDIR ?? '/tmp/swarm-smoke';

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

let rr = 0;
function nextServer(): string {
  const s = SERVERS[rr % SERVERS.length];
  rr += 1;
  return s ?? SERVERS[0] ?? 'http://127.0.0.1:4242';
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

// Create a session (round-robin) + fire-and-forget the task prompt.
export async function spawnAgent(name: string, task: string): Promise<SessionHandle> {
  const server = nextServer();
  const created = await oc('POST', server, '/api/session', {
    model: MODEL,
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

// Abort a session. Real impl must preserve the worktree branch FIRST (invariant).
export async function abortAgent(id: string, server: string): Promise<{ cost: number }> {
  await oc('POST', server, `/session/${id}/abort`);
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