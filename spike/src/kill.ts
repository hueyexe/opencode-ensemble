import { Connection, Client } from '@temporalio/client';
import { killAllSignal } from './workflows';

async function run() {
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: 'default' });
  const workflowId = process.argv[2];
  if (!workflowId) {
    console.error('usage: bun run src/kill.ts <workflowId>');
    process.exit(1);
  }
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(killAllSignal);
  console.log('Sent killAll signal to', workflowId);
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});