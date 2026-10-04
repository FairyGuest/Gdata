import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';
import { generateStream, makeReplayBatches, FIXTURE_SEED } from '../src/fixtures/generator.ts';
import { referenceProjection, stableStringify } from '../src/fixtures/reference.ts';

const RUN = 'test-rebuild-' + process.pid;

async function replayFixture(stream: ReturnType<typeof generateStream>) {
  const app = buildServer({ dbPath: ':memory:', runId: RUN });
  const batches = makeReplayBatches(stream, 3);
  let duplicates = 0;
  let gaps = 0;
  // Out-of-order batches are rejected with event_gap and must be re-delivered
  // by the upstream; loop the shuffled plan until the stream converges.
  for (let round = 0; round < 6; round++) {
    for (const batch of batches) {
      const res = await app.inject({ method: 'POST', url: '/events/batch', payload: { events: batch } });
      assert.equal(res.statusCode, 200);
      for (const item of res.json().results) {
        if (!item.ok && item.reason === 'duplicate_event') duplicates++;
        if (!item.ok && item.reason === 'event_gap') gaps++;
      }
    }
    const status = (await app.inject({ method: 'GET', url: '/diag/status' })).json();
    if (status.appliedSeq === stream.length) break;
  }
  assert.ok(duplicates > 0, 'fixture must actually exercise duplicate rejection');
  assert.ok(gaps > 0, 'fixture must actually exercise out-of-order gaps');
  return app;
}

async function projectionOf(app: ReturnType<typeof buildServer>) {
  return (await app.inject({ method: 'GET', url: '/diag/projection' })).json();
}

test('out-of-order + duplicated replay converges to the full stream projection', async () => {
  const stream = generateStream(35, FIXTURE_SEED);
  const app = await replayFixture(stream);
  const proj = await projectionOf(app);
  const ref = referenceProjection(stream);
  assert.equal(proj.appliedSeq, 35);
  assert.deepEqual(proj.owners, ref.owners);
  assert.deepEqual(proj.stats, { volume: ref.volume, floor: ref.floor, salesCount: ref.salesCount });
  assert.deepEqual(proj.lastSale, ref.lastSale);
});

test('rebuild at two sampled heights matches the reference oracle bitwise', async () => {
  const stream = generateStream(35, FIXTURE_SEED);
  const app = await replayFixture(stream);
  for (const h of [12, 27]) {
    const rb = await app.inject({ method: 'POST', url: '/rebuild', payload: { toSeq: h } });
    assert.equal(rb.statusCode, 200);
    const proj = await projectionOf(app);
    const ref = referenceProjection(stream, h);
    assert.equal(proj.appliedSeq, h);
    assert.equal(
      stableStringify({ owners: proj.owners, stats: proj.stats, lastSale: proj.lastSale }),
      stableStringify({
        owners: ref.owners,
        stats: { volume: ref.volume, floor: ref.floor, salesCount: ref.salesCount },
        lastSale: ref.lastSale,
      }),
      'rebuild(' + h + ') must be bitwise identical to the reference',
    );
  }
});

test('rebuild(full) after incremental replay reproduces the incremental projection bitwise', async () => {
  const stream = generateStream(35, FIXTURE_SEED);
  const app = await replayFixture(stream);
  const before = await projectionOf(app);
  const rb = await app.inject({ method: 'POST', url: '/rebuild', payload: { toSeq: 35 } });
  assert.equal(rb.statusCode, 200);
  const after = await projectionOf(app);
  assert.equal(stableStringify(before), stableStringify(after));
});

test('rebuild beyond the logged range is rejected with event_gap and does not corrupt projection', async () => {
  const stream = generateStream(10, FIXTURE_SEED);
  const app = await replayFixture(stream);
  const before = await projectionOf(app);
  const rb = await app.inject({ method: 'POST', url: '/rebuild', payload: { toSeq: 99 } });
  assert.equal(rb.statusCode, 409);
  assert.equal(rb.json().error.reason, 'event_gap');
  const after = await projectionOf(app);
  assert.equal(stableStringify(before), stableStringify(after));
});
