import { nativeStructured } from '../src/native';

const schema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

const N = Number(process.argv[2] ?? 15);
const t0 = Date.now();
const results = await Promise.allSettled(
  Array.from({ length: N }, (_, i) =>
    nativeStructured(
      { providerID: 'cloudflare-workers-ai', id: '@cf/deepseek-ai/deepseek-v4-flash-0731' },
      `You are a judge. Return a verdict object. (${i})`,
      schema,
    ),
  ),
);
const elapsed = Math.round((Date.now() - t0) / 1000);
const ok = results.filter((r) => r.status === 'fulfilled').length;
const fail = results.filter((r) => r.status === 'rejected').length;
console.log(`native N=${N} elapsed=${elapsed}s ok=${ok} fail=${fail}`);
for (const r of results) {
  if (r.status === 'rejected') {
    console.log('  sample fail:', String(r.reason).slice(0, 160));
    break;
  }
}
for (const r of results) {
  if (r.status === 'fulfilled') {
    console.log('  sample ok:', JSON.stringify(r.value).slice(0, 160));
    break;
  }
}