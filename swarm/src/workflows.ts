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
    const session = await spawnAgent(name, task, servers);
    server = session.server;
    sessionId = session.id;
    cost += session.cost;

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

    let result: AgentResult;
    if (done && ok) {
      const verdict = await judge(name, session.id, session.server, task, session.summary, session.model);
      cost += verdict.cost;
      result = {
        name,
        status: verdict.verdict === 'accept' ? 'completed' : 'failed',
        result: `${verdict.verdict}: ${verdict.reason}`,
        cost,
      };
    } else {
      result = { name, status: 'failed', cost };
    }

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
  setHandler(statusQuery, () => ({
    agentCount: tasks.length,
    results: [...finished],
    totalCost: finished.reduce((s, r) => s + r.cost, 0),
    paused,
    killed: killAll,
    messages: [...messages],
  }));

  const estimated = tasks.length * 0.01;
  if (estimated > budget) {
    throw new Error(`estimated cost ${estimated} exceeds budget ${budget}`);
  }

  // One shared execution environment for the whole swarm (contained).
  const provision = await provisionSandbox();
  const servers = provision.servers;
  const sharedSandbox = provision.sandbox;

  handles = await Promise.all(
    tasks.map((task, i) =>
      startChild(agentWorkflow, {
        workflowId: `${runId}-agent-${i}`,
        args: [`agent-${i}`, task, servers],
      }),
    ),
  );

  let results: AgentResult[];
  let killed = false;

  const completed = Promise.all(handles.map((h) => h.result()));
  const killReached = condition(() => killAll);

  const winner = await Promise.race([
    completed.then((r) => ({ kind: 'done' as const, results: r })),
    killReached.then(() => ({ kind: 'kill' as const })),
  ]);

  if (winner.kind === 'kill') {
    killed = true;
    await Promise.allSettled(
      handles.map((h) => getExternalWorkflowHandle(h.workflowId).cancel()),
    );
    const settled = await Promise.allSettled(handles.map((h) => h.result()));
    results = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : ({ name: `agent-${i}`, status: 'aborted', cost: 0 } as AgentResult),
    );
  } else {
    results = winner.results;
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