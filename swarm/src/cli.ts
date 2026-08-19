import { Connection, Client } from '@temporalio/client';
import {
  killAllSignal,
  pauseSignal,
  resumeSignal,
  messageSignal,
  statusQuery,
  type SwarmResult,
  type SwarmStatus,
} from './workflows';

const DEFAULT_TASKS = [
  'Summarize what a Temporal workflow is in one sentence.',
  'Summarize what structured outputs are in one sentence.',
];

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: 'default' });

  switch (cmd) {
    case 'run': {
      const tasks = rest.length ? rest : DEFAULT_TASKS;
      const runId = Date.now().toString();
      const concurrency = Math.max(1, Number(process.env.OPENCODE_SWARM_CONCURRENCY ?? '5'));
      const t0 = Date.now();
      const handle = await client.workflow.start('swarmRunWorkflow', {
        taskQueue: 'swarm-tasks',
        workflowId: `swarm-${runId}`,
        args: [runId, tasks, 5, concurrency],
      });
      console.log(`swarm started: ${handle.workflowId} (${tasks.length} agents)`);
      const result = (await handle.result()) as SwarmResult;
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
      const status = await client.workflow.getHandle(wfId).query<SwarmStatus>(statusQuery);
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case 'pause': {
      const wfId = rest[0];
      if (!wfId) throw new Error('pause needs a workflowId');
      await client.workflow.getHandle(wfId).signal(pauseSignal);
      console.log(`pause sent to ${wfId}`);
      break;
    }
    case 'resume': {
      const wfId = rest[0];
      if (!wfId) throw new Error('resume needs a workflowId');
      await client.workflow.getHandle(wfId).signal(resumeSignal);
      console.log(`resume sent to ${wfId}`);
      break;
    }
    case 'msg': {
      const [wfId, agent, ...textParts] = rest;
      if (!wfId || !agent || textParts.length === 0) {
        throw new Error('msg needs workflowId, agent (or *), and text');
      }
      await client.workflow.getHandle(wfId).signal(messageSignal, {
        agent,
        text: textParts.join(' '),
      });
      console.log(`message sent to ${agent} in ${wfId}`);
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
      console.log(
        'usage: swarmctl run [task...] | status <wfId> | pause <wfId> | resume <wfId> | msg <wfId> <agent|*> <text> | kill-all <wfId>',
      );
  }
}

main().catch((e) => {
  console.error('swarmctl failed:', e);
  process.exit(1);
});