// Integration: runs the real kernel against fixture projects.
// Expected outcomes below are derived by hand from the fixture sources,
// not from the implementation under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MutationStore } from '../src/store/sqlite.ts';
import { MutationService } from '../src/service.ts';
import { loadConfig } from '../src/config.ts';
import { ServiceError } from '../src/contract/errors.ts';

const config = loadConfig({ MTS_EXECUTOR: process.env.MTS_EXECUTOR ?? 'inprocess' });
const silent = () => {};

function makeService() {
  return new MutationService(new MutationStore(':memory:'), config, silent);
}

test('killed fixture: every mutant is detected, score is 1', async () => {
  const svc = makeService();
  const rec = await svc.run({ projectDir: 'fixtures/killed' });
  assert.equal(rec.total, 1);
  assert.equal(rec.killed, 1);
  assert.equal(rec.survived, 0);
  assert.equal(rec.score, 1);
  assert.equal(rec.results[0].status, 'killed');
  assert.equal(rec.results[0].mutant.type, 'ArithmeticOperator');
  assert.ok(rec.results[0].reason.includes('exit'));
  assert.ok(rec.results[0].testExitCode !== 0);
});

test('survived fixture: mutant is not detected, score is 0', async () => {
  const svc = makeService();
  const rec = await svc.run({ projectDir: 'fixtures/survived' });
  assert.equal(rec.total, 1);
  assert.equal(rec.killed, 0);
  assert.equal(rec.survived, 1);
  assert.equal(rec.score, 0);
  assert.equal(rec.results[0].status, 'survived');
  assert.equal(rec.results[0].testExitCode, 0);
  assert.equal(rec.survivors.length, 1);
  assert.equal(rec.survivors[0].original, '*');
});

test('mixed fixture: score 4/5 and the multiply mutant survives', async () => {
  const svc = makeService();
  const rec = await svc.run({ projectDir: 'fixtures/sample' });
  assert.equal(rec.total, 5);
  assert.equal(rec.killed, 4);
  assert.equal(rec.survived, 1);
  assert.equal(rec.score, 0.8);
  assert.equal(rec.survivors.length, 1);
  assert.equal(rec.survivors[0].file, 'src/calc.js');
  assert.equal(rec.survivors[0].type, 'ArithmeticOperator');
  assert.equal(rec.survivors[0].original, '*');
  const byStatus = new Map(rec.results.map((r) => [r.mutant.id, r.status]));
  for (const r of rec.results) {
    if (r.mutant.original === '*') assert.equal(byStatus.get(r.mutant.id), 'survived');
    else assert.equal(byStatus.get(r.mutant.id), 'killed');
  }
});

test('history: run persisted, queryable by file and by mutation type', async () => {
  const svc = makeService();
  const rec = await svc.run({ projectDir: 'fixtures/sample' });
  const fetched = svc.getRun(rec.runId);
  assert.equal(fetched.total, 5);
  assert.equal(fetched.results.length, 5);

  const arith = svc.queryMutants({ type: 'ArithmeticOperator' });
  assert.equal(arith.length, 2);
  const notifyFile = svc.queryMutants({ file: 'src/notify.js' });
  assert.equal(notifyFile.length, 2);
  const survived = svc.queryMutants({ status: 'survived' });
  assert.equal(survived.length, 1);
  assert.equal(survived[0].mutant.original, '*');
});

test('unknown run id yields NOT_FOUND', async () => {
  const svc = makeService();
  assert.throws(() => svc.getRun('00000000-0000-0000-0000-000000000000'),
    (err: unknown) => err instanceof ServiceError && (err as ServiceError).code === 'NOT_FOUND');
});

test('mutant budget overflow yields RESOURCE_EXHAUSTED', async () => {
  const svc = makeService();
  await assert.rejects(() => svc.run({ projectDir: 'fixtures/sample', maxMutants: 2 }),
    (err: unknown) => err instanceof ServiceError && (err.code === 'RESOURCE_EXHAUSTED'));
});

test('concurrent runs on the same project yield STATE_CONFLICT', async () => {
  const svc = makeService();
  const first = svc.run({ projectDir: 'fixtures/sample' });
  await assert.rejects(() => svc.run({ projectDir: 'fixtures/sample' }),
    (err: unknown) => err instanceof ServiceError && (err.code === 'STATE_CONFLICT'));
  await first;
});

test('bad test command yields EXECUTION_FAILED', async () => {
  const spawnConfig = loadConfig({ MTS_EXECUTOR: 'spawn' });
  const svc = new MutationService(new MutationStore(':memory:'), spawnConfig, silent);
  await assert.rejects(
    () => svc.run({ projectDir: 'fixtures/killed', testCommand: 'definitely-not-a-real-binary-xyz' }),
    (err: unknown) => err instanceof ServiceError && (err.code === 'EXECUTION_FAILED'));
});

