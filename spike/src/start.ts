import { Connection, Client } from '@temporalio/client';

async function run() {
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: 'default' });

  const runId = Date.now().toString();
  const tasks = [
    'Summarize what a Temporal workflow is in one sentence.',
    'Summarize what a git worktree is in one sentence.',
    'Summarize what structured outputs are in one sentence.',
  ];
  const handle = await client.workflow.start('swarmRunWorkflow', {
    taskQueue: 'swarm-tasks',
    workflowId: `swarm-${runId}`,
    args: [runId, tasks, 0.5],
  });

  console.log('Started swarm:', handle.workflowId);
  const result = await handle.result();
  console.log('SWARM RESULT:');
  console.log(JSON.stringify(result, null, 2));
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});