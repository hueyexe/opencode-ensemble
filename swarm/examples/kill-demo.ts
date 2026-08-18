import { Connection, Client } from '@temporalio/client';
import { killAllSignal } from '../src/workflows';

async function run() {
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: 'default' });

  const runId = Date.now().toString();
  const tasks = [
    'Summarize what a Temporal workflow is in one sentence.',
    'Summarize what a git worktree is in one sentence.',
    'Summarize what structured outputs are in one sentence.',
    'Summarize what a Docker container is in one sentence.',
  ];
  const handle = await client.workflow.start('swarmRunWorkflow', {
    taskQueue: 'swarm-tasks',
    workflowId: `swarm-${runId}`,
    args: [runId, tasks, 5],
  });
  console.log('Started:', handle.workflowId);

  // Let it spawn, then kill everything mid-flight.
  await new Promise((r) => setTimeout(r, 4000));
  await handle.signal(killAllSignal);
  console.log('Sent killAll signal');

  const result = (await handle.result()) as {
    killed: boolean;
    totalCost: number;
    agents: { status: string }[];
  };
  console.log('KILL RESULT:', JSON.stringify({
    killed: result.killed,
    totalCost: result.totalCost,
    agentCount: result.agents.length,
    statuses: result.agents.map((a) => a.status),
  }));
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});