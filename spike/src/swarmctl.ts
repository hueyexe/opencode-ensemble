import { Connection, Client } from '@temporalio/client';
import { killAllSignal } from './workflows';

const DEFAULT_TASKS = [
  'Summarize what a Temporal workflow is in one sentence.',
  'Summarize what structured outputs are in one sentence.',
];

interface SwarmOutcome {
  killed: boolean;
  totalCost: number;
  agents: { name: string; status: string; result?: string; cost: number }[];
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: 'default' });

  switch (cmd) {
    case 'run': {
      const tasks = rest.length ? rest : DEFAULT_TASKS;
      const runId = Date.now().toString();
      const t0 = Date.now();
      const handle = await client.workflow.start('swarmRunWorkflow', {
        taskQueue: 'swarm-tasks',
        workflowId: `swarm-${runId}`,
        args: [runId, tasks, 5],
      });
      console.log(`swarm started: ${handle.workflowId} (${tasks.length} agents)`);
      const result = (await handle.result()) as SwarmOutcome;
      const counts: Record<string, number> = {};
      for (const a of result.agents) counts[a.status] = (counts[a.status] ?? 0) + 1;
      console.log(
        `done in ${((Date.now() - t0) / 1000).toFixed(1)}s | cost $${result.totalCost} | ${JSON.stringify(counts)}`,
      );
      break;
    }
    case 'status': {
      const wfId = rest[0];
      if (!wfId) throw new Error('status needs a workflowId');
      const desc = await client.workflow.getHandle(wfId).describe();
      console.log(`${wfId}: ${desc.status.name}`);
      break;
    }
    case 'kill-all': {
      const wfId = rest[0];
      if (!wfId) throw new Error('kill-all needs a workflowId');
      await client.workflow.getHandle(wfId).signal(killAllSignal);
      console.log(`killAll sent to ${wfId}`);
      break;
    }
    default:
      console.log('usage: swarmctl run [task...] | status <wfId> | kill-all <wfId>');
  }
}

main().catch((e) => {
  console.error('swarmctl failed:', e);
  process.exit(1);
});