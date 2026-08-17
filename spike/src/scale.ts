import { Connection, Client } from '@temporalio/client';

const TOPICS = [
  'a Temporal workflow', 'a git worktree', 'structured outputs', 'a Docker container',
  'a microVM', 'a cron job', 'a webhook', 'an idempotency key',
  'a retry policy', 'a heartbeat', 'a circuit breaker', 'a work queue',
  'event sourcing', 'a saga pattern', 'a dead letter queue', 'a rate limiter',
  'a distributed lock', 'a parent-child workflow', 'a deterministic function', 'backpressure',
];

async function run() {
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: 'default' });

  const runId = Date.now().toString();
  const tasks = TOPICS.map((t) => `Summarize what ${t} is in one sentence.`);
  const t0 = Date.now();
  const handle = await client.workflow.start('swarmRunWorkflow', {
    taskQueue: 'swarm-tasks',
    workflowId: `swarm-${runId}`,
    args: [runId, tasks, 5],
  });
  console.log('Started 20-agent swarm:', handle.workflowId);

  const result = (await handle.result()) as {
    killed: boolean;
    totalCost: number;
    agents: { name: string; status: string; result?: string; cost: number }[];
  };
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const counts = result.agents.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('SCALE RESULT:');
  console.log(JSON.stringify({ elapsed: `${elapsed}s`, totalCost: result.totalCost, statuses: counts }, null, 2));
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});