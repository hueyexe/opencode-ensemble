import {
  proxyActivities,
  startChild,
  setHandler,
  condition,
  defineSignal,
  sleep,
  getExternalWorkflowHandle,
  isCancellation,
  CancellationScope,
} from '@temporalio/workflow';
import type * as activities from './activities';

const { spawnAgent, abortAgent, judge } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

// Heartbeat-enabled: a poll that stalls beyond this window trips the activity's
// heartbeat timeout, which is how a runaway agent gets detected durably.
const { pollAgent } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '15 seconds',
});

export const killAllSignal = defineSignal('killAll');

export interface AgentResult {
  name: string;
  status: 'completed' | 'failed' | 'aborted';
  result?: string;
  cost: number;
}

export interface SwarmResult {
  agents: AgentResult[];
  totalCost: number;
  killed: boolean;
}

// One task's full lifecycle: spawn -> poll (heartbeat) -> judge.
export async function agentWorkflow(name: string, task: string): Promise<AgentResult> {
  let cost = 0;
  let sessionId: string | undefined;
  let server: string | undefined;
  try {
    const session = await spawnAgent(name, task);
    sessionId = session.id;
    server = session.server;
    cost += session.cost;

    let done = false;
    let ok = false;
    for (let attempt = 1; attempt <= 40 && !done; attempt++) {
      const poll = await pollAgent(session.id, attempt, session.server);
      cost = poll.cost; // cumulative session cost
      done = poll.done;
      ok = poll.ok;
      if (!done) await sleep('3 seconds');
    }
    if (done && ok) {
      const verdict = await judge(name, session.id, session.server);
      cost += verdict.cost;
      return {
        name,
        status: verdict.verdict === 'accept' ? 'completed' : 'failed',
        result: `${verdict.verdict}: ${verdict.reason}`,
        cost,
      };
    }
    return { name, status: 'failed', cost };
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
          // best-effort cleanup; a failed abort leaves an orphan (flag in real impl)
        }
      }
      return { name, status: 'aborted', cost };
    }
    return { name, status: 'failed', cost };
  }
}

// Parent: budget cap, kill-all signal, result + cost aggregation.
export async function swarmRunWorkflow(
  runId: string,
  tasks: string[],
  budget: number,
): Promise<SwarmResult> {
  let killAll = false;
  setHandler(killAllSignal, () => {
    killAll = true;
  });

  const estimated = tasks.length * 0.01;
  if (estimated > budget) {
    throw new Error(`estimated cost ${estimated} exceeds budget ${budget}`);
  }

  const handles = await Promise.all(
    tasks.map((task, i) =>
      startChild(agentWorkflow, {
        workflowId: `${runId}-agent-${i}`,
        args: [`agent-${i}`, task],
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

  return {
    agents: results,
    totalCost: results.reduce((s, r) => s + r.cost, 0),
    killed,
  };
}