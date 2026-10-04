import { generateStream, makeReplayBatches, FIXTURE_SEED } from '../src/fixtures/generator.ts';
import { buildServer } from '../src/server.ts';

const stream = generateStream(35, FIXTURE_SEED);
const app = buildServer({ dbPath: ':memory:', runId: 'dbg' });
const batches = makeReplayBatches(stream, 7);
for (let round = 0; round < 6; round++) {
  for (const batch of batches) {
    const res = await app.inject({ method: 'POST', url: '/events/batch', payload: { events: batch } });
    const fails = res.json().results.filter((x: { ok: boolean; reason?: string }) => !x.ok && x.reason !== 'duplicate_event' && x.reason !== 'event_gap');
    if (fails.length) console.log('round', round, 'HARD FAIL', JSON.stringify(fails));
  }
  const st = (await app.inject({ method: 'GET', url: '/diag/status' })).json();
  console.log('round', round, 'appliedSeq', st.appliedSeq);
  if (st.appliedSeq === 35) break;
}
const rej = (await app.inject({ method: 'GET', url: '/diag/rejections' })).json();
const bad = rej.rejections.filter((r: { reason: string }) => r.reason === 'invalid_transition');
console.log('invalid_transition count', bad.length, JSON.stringify(bad.slice(0, 3), null, 1));
