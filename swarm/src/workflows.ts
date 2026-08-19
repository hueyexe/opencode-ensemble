import {
  proxyActivities,
  startChild,
  setHandler,
  condition,
  defineSignal,
  defineQuery,
  sleep,
  getExternalWorkflowHandle,
  isCancellation,
  CancellationScope,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities';

const { provisionSandbox, spawnAgent, abortAgent, teardownSandbox } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
});

const { judge } = proxyActivities<typeof activities>({
  startToCloseTimeout: '4 minutes',
});

const { sendMessage } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

// Heartbeat-enabled: a poll that stalls beyond this window trips the activity's
// heartbeat timeout, which is how a runaway agent gets detected durably.
const { pollAgent } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '15 seconds',
});

export const killAllSignal = defineSignal('killAll');
export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const messageSignal = defineSignal<[{ agent: string; text: string }]>('message');
export const agentPauseSignal = defineSignal('agentPause');
export const agentResumeSignal = defineSignal('agentResume');
export const agentMessageSignal = defineSignal<[{ text: string }]>('agentMessage');
export const agentDoneSignal = defineSignal<[AgentResult]>('agentDone');
export const statusQuery = defineQuery<SwarmStatus>('status');

export interface AgentResult {
  name: string;
  status: 'completed' | 'failed' | 'aborted';
  result?: string;
  cost: number;
}

export interface SwarmStatus {
  agentCount: number;
  results: AgentResult[];
  totalCost: number;
  paused: boolean;
  killed: boolean;
  messages: string[];
}

export interface SwarmResult {
  agents: AgentResult[];
  totalCost: number;
  killed: boolean;
}

// One task's full lifecycle: spawn -> poll (heartbeat) -> judge. Pausable,
// accepts injected messages, and reports completion to the parent for live status.
// Runs on the swarm's shared server (provisioned once by the parent), so no
// per-agent sandbox lifecycle lives here.
export async function agentWorkflow(
  name: string,
  task: string,
  servers: string[],
  maxRetries: number,
): Promise<AgentResult> {
  let cost = 0;
  let sessionId: string | undefined;
  let server: string | undefined;
  let paused = false;
  let pendingMessage: string | undefined;

  setHandler(agentPauseSignal, () => {
    paused = true;
  });
  setHandler(agentResumeSignal, () => {
    paused = false;
  });
  setHandler(agentMessageSignal, ({ text }) => {
    pendingMessage = text;
  });

  try {
    const retries = Math.max(0, maxRetries);
    let session = await spawnAgent(name, task, servers);
    server = session.server;
    sessionId = session.id;
    cost += session.cost;

    let result: AgentResult | undefined;

    // Drive the agent to completion; if its model call stalls (rate-limit),
    // abort the hung session and re-drive with bounded backoff instead of failing.
    for (let retry = 0; retry <= retries && !result; retry++) {
      let done = false;
      let ok = false;
      for (let attempt = 1; attempt <= 40 && !done; attempt++) {
        await condition(() => !paused);
        if (pendingMessage !== undefined) {
          const msg = pendingMessage;
          pendingMessage = undefined;
          await sendMessage(session.id, session.server, msg);
        }
        const poll = await pollAgent(session.id, attempt, session.server);
        cost = poll.cost;
        done = poll.done;
        ok = poll.ok;
        if (!done) await sleep('3 seconds');
      }

      if (done && ok) {
        const verdict = await judge(name, session.id, session.server);
        cost += verdict.cost;
        result = {
          name,
          status: verdict.verdict === 'accept' ? 'completed' : 'failed',
          result: `${verdict.verdict}: ${verdict.reason}`,
          cost,
        };
      } else if (retry < retries) {
        // Stalled (rate-limit): abort the hung session and re-drive with backoff.
        // The re-spawn round-robins models, so the retry may land on a different
        // provider and clear the throttle.
        await abortAgent(session.id, session.server);
        await sleep(`${10 * (retry + 1)} seconds`);
        session = await spawnAgent(name, task, servers);
        server = session.server;
        sessionId = session.id;
        cost += session.cost;
      } else {
        result = { name, status: 'failed', cost };
      }
    }

    if (!result) result = { name, status: 'failed', cost };

    const parentId = workflowInfo().parent?.workflowId;
    if (parentId) {
      await getExternalWorkflowHandle(parentId).signal(agentDoneSignal, result);
    }
    return result;
  } catch (e) {
    if (isCancellation(e)) {
      // No-runaway: abort the serve session so kill-all leaves no orphans.
      // Non-cancellable so the abort actually runs during cancellation.
      if (sessionId && server) {
        const sid = sessionId;
        const srv = server;
        try {
          await CancellationScope.nonCancellable(() => abortAgent(sid, srv));
        } catch {
          // best-effort cleanup
        }
      }
      return { name, status: 'aborted', cost };
    }
    return { name, status: 'failed', cost };
  }
}

// Parent: provisions ONE shared sandbox (the whole swarm runs inside it), applies
// the budget cap, handles kill-all/pause/resume/message signals + live status
// query, and aggregates results + cost. Tears down the shared sandbox at the end.
export async function swarmRunWorkflow(
  runId: string,
  tasks: string[],
  budget: number,
  concurrency: number,
  maxRetries: number,
): Promise<SwarmResult> {
  let killAll = false;
  let paused = false;
  const messages: string[] = [];
  const finished: AgentResult[] = [];
  let handles: Array<{ workflowId: string; result: () => Promise<AgentResult> }> = [];

  setHandler(killAllSignal, () => {
    killAll = true;
  });
  setHandler(pauseSignal, () => {
    paused = true;
    for (const h of handles) void getExternalWorkflowHandle(h.workflowId).signal(agentPauseSignal);
  });
  setHandler(resumeSignal, () => {
    paused = false;
    for (const h of handles) void getExternalWorkflowHandle(h.workflowId).signal(agentResumeSignal);
  });
  setHandler(messageSignal, ({ agent, text }) => {
    messages.push(`[${agent}] ${text}`);
    handles.forEach((h, i) => {
      if (agent === '*' || agent === `agent-${i}`) {
        void getExternalWorkflowHandle(h.workflowId).signal(agentMessageSignal, { text });
      }
    });
  });
  setHandler(agentDoneSignal, (r) => {
    finished.push(r);
  });

  // Upfront estimate: ~$0.002/agent is a conservative default for cheap models
  // (observed ~$0.001/agent on DeepSeek Flash with OpenRouter prompt caching).
  const estimated = tasks.length * 0.002;
  if (estimated > budget) {
    throw new Error(`estimated cost $${estimated.toFixed(3)} exceeds budget $${budget}`);
  }

  setHandler(statusQuery, () => {
    const totalCost = finished.reduce((s, r) => s + r.cost, 0);
    return {
      agentCount: tasks.length,
      results: [...finished],
      totalCost,
      estimated,
      budget,
      percentUsed: budget > 0 ? totalCost / budget : 0,
      paused,
      killed: killAll,
      messages: [...messages],
    };
  });

  // One shared execution environment for the whole swarm (contained).
  const provision = await provisionSandbox();
  const servers = provision.servers;
  const sharedSandbox = provision.sandbox;

  // Graceful budget limiter: spawn agents in WAVES of `concurrency` so the swarm
  // queues work instead of firing N model calls at once and rate-limit-stalling
  // the whole wave. Each wave completes (or kill-all fires) before the next.
  const maxConcurrent = Math.max(1, concurrency);
  let killed = false;
  for (let i = 0; i < tasks.length && !killed; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    const batchHandles = await Promise.all(
      batch.map((task, j) =>
        startChild(agentWorkflow, {
          workflowId: `${runId}-agent-${i + j}`,
          args: [`agent-${i + j}`, task, servers, maxRetries],
        }),
      ),
    );
    handles.push(...batchHandles);

    const winner = await Promise.race([
      Promise.all(batchHandles.map((h) => h.result())).then(() => 'done' as const),
      condition(() => killAll).then(() => 'kill' as const),
    ]);

    if (winner === 'kill') {
      killed = true;
    } else if (finished.reduce((s, r) => s + r.cost, 0) > budget) {
      // Budget cap: stop spawning further waves once the swarm's live cost
      // exceeds the user's budget (already-spawned agents still settle).
      killed = true;
    }
  }

  // On kill-all, cancel any in-flight agents, then settle every spawned handle.
  if (killed) {
    await Promise.allSettled(
      handles.map((h) => getExternalWorkflowHandle(h.workflowId).cancel()),
    );
  }
  const settled = await Promise.allSettled(handles.map((h) => h.result()));
  const results: AgentResult[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : ({ name: `agent-${i}`, status: 'aborted', cost: 0 } as AgentResult),
  );
  // Agents never spawned (waves skipped when kill-all fired early) → aborted.
  for (let k = settled.length; k < tasks.length; k++) {
    results.push({ name: `agent-${k}`, status: 'aborted', cost: 0 });
  }

  // Tear down the shared sandbox (kill-all leaves no orphan microVM).
  if (sharedSandbox) {
    try {
      await teardownSandbox(sharedSandbox);
    } catch {
      // best-effort; a failed teardown leaves an orphan (flag in real impl)
    }
  }

  return {
    agents: results,
    totalCost: results.reduce((s, r) => s + r.cost, 0),
    killed,
  };
}