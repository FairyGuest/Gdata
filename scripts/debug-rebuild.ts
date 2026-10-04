import { generateStream, makeReplayBatches, FIXTURE_SEED } from '../src/fixtures/generator.ts';
import { buildServer } from '../src/server.ts';
import { stableStringify } from '../src/fixtures/reference.ts';

const stream = generateStream(40, FIXTURE_SEED);
const app = buildServer({ dbPath: ':memory:', runId: 'dbg' });
for (const ev of stream) await app.inject({ method: 'POST', url: '/events', payload: { event: ev } });
await app.inject({ method: 'POST', url: '/rebuild', payload: { toSeq: 40 } });
const a = (await app.inject({ method: 'GET', url: '/diag/projection' })).json();
await app.inject({ method: 'POST', url: '/rebuild', payload: { toSeq: 40 } });
const b = (await app.inject({ method: 'GET', url: '/diag/projection' })).json();
console.log('equal:', stableStringify(a) === stableStringify(b));
const sa = stableStringify(a); const sb = stableStringify(b);
for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
  if (sa[i] !== sb[i]) { console.log('first diff at', i); console.log('A:', sa.slice(Math.max(0,i-60), i+80)); console.log('B:', sb.slice(Math.max(0,i-60), i+80)); break; }
}
