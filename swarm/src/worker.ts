import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const connection = await NativeConnection.connect({ address: '127.0.0.1:7233' });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'swarm-tasks',
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  console.log('Swarm worker running on task queue: swarm-tasks');
  await worker.run();
}

run().catch((err) => {
  console.error('WORKER FAILED:', err);
  process.exit(1);
});