import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';
import { generateStream, makeConflicting, FIXTURE_SEED } from '../src/fixtures/generator.ts';
import { referenceProjection } from '../src/fixtures/reference.ts';

const RUN = 'test-kernel-' + process.pid;

function server() {
  return buildServer({ dbPath: ':memory:', runId: RUN });
}

async function postEvent(app: ReturnType<typeof server>, ev: unknown) {
  const res = await app.inject({ method: 'POST', url: '/events', payload: { event: ev } });
  return { status: res.statusCode, body: res.json() };
}

test('concurrent duplicate submit: exactly one 200 and one 409 duplicate_event, stats counted once', async () => {
  const app = server();
  const [ev1, ev2] = generateStream(2, FIXTURE_SEED);
  await postEvent(app, ev1);
  // ev2 is a sale or transfer; use a guaranteed sale for the volume assertion
  const sale = { seq: 2, type: 'sale', tokenId: ev1!.tokenId, from: ev1!.to, to: '0x' + 'f'.repeat(40), price: 77 };
  const [r1, r2] = await Promise.all([postEvent(app, sale), postEvent(app, { ...sale })]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = r1.status === 409 ? r1 : r2;
  assert.equal(loser.body.error.reason, 'duplicate_event');
  const stats = (await app.inject({ method: 'GET', url: '/diag/stats' })).json();
  assert.equal(stats.volume, 77, 'volume must count the sale exactly once');
  assert.equal(stats.floor, 77);
  assert.equal(stats.salesCount, 1);
  assert.equal(stats.appliedSeq, 2);
});

test('same seq with different content: 409 duplicate_event, no silent overwrite', async () => {
  const app = server();
  const [ev1] = generateStream(1, FIXTURE_SEED);
  await postEvent(app, ev1);
  const conflict = makeConflicting(ev1!);
  const r = await postEvent(app, conflict);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.reason, 'duplicate_event');
  const owner = (await app.inject({ method: 'GET', url: '/diag/owner/' + ev1!.tokenId })).json();
  assert.equal(owner.owner, ev1!.to, 'original content must survive');
});

test('gap: seq jump rejected with event_gap, projection stays at last contiguous seq', async () => {
  const app = server();
  const [ev1, , ev3] = generateStream(3, FIXTURE_SEED);
  await postEvent(app, ev1);
  const r = await postEvent(app, ev3);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.reason, 'event_gap');
  const status = (await app.inject({ method: 'GET', url: '/diag/status' })).json();
  assert.equal(status.appliedSeq, 1);
});

test('invalid transfer (from != current owner): whole event rejected, appliedSeq frozen, later legal event applies', async () => {
  const app = server();
  const [ev1] = generateStream(1, FIXTURE_SEED);
  await postEvent(app, ev1);
  const bad = { seq: 2, type: 'transfer', tokenId: ev1!.tokenId, from: '0x' + '9'.repeat(40), to: '0x' + 'e'.repeat(40), price: null };
  const rBad = await postEvent(app, bad);
  assert.equal(rBad.status, 409);
  assert.equal(rBad.body.error.reason, 'invalid_transition');
  let status = (await app.inject({ method: 'GET', url: '/diag/status' })).json();
  assert.equal(status.appliedSeq, 1, 'appliedSeq must not advance');
  const good = { ...bad, from: ev1!.to };
  const rGood = await postEvent(app, good);
  assert.equal(rGood.status, 200);
  status = (await app.inject({ method: 'GET', url: '/diag/status' })).json();
  assert.equal(status.appliedSeq, 2);
  const owner = (await app.inject({ method: 'GET', url: '/diag/owner/' + ev1!.tokenId })).json();
  assert.equal(owner.owner, good.to);
});

test('incremental projection equals independent reference oracle', async () => {
  const app = server();
  const stream = generateStream(40, FIXTURE_SEED);
  for (const ev of stream) {
    const r = await postEvent(app, ev);
    assert.equal(r.status, 200, 'seq ' + ev.seq + ' rejected unexpectedly: ' + JSON.stringify(r.body));
  }
  const proj = (await app.inject({ method: 'GET', url: '/diag/projection' })).json();
  const ref = referenceProjection(stream);
  assert.equal(proj.appliedSeq, ref.appliedSeq);
  assert.deepEqual(proj.owners, ref.owners);
  assert.equal(proj.stats.volume, ref.volume);
  assert.equal(proj.stats.floor, ref.floor);
  assert.equal(proj.stats.salesCount, ref.salesCount);
  assert.deepEqual(proj.lastSale, ref.lastSale);
});

test('malformed input maps to 422 invalid_input, not a success', async () => {
  const app = server();
  const r = await postEvent(app, { seq: 'x', type: 'mint' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.reason, 'invalid_input');
});

test('oversized batch maps to 503 resource_exhausted', async () => {
  const app = buildServer({ dbPath: ':memory:', runId: RUN, maxBatchSize: 3 });
  const res = await app.inject({
    method: 'POST',
    url: '/events/batch',
    payload: { events: generateStream(4, FIXTURE_SEED) },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.reason, 'resource_exhausted');
});
