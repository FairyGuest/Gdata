import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRuns } from '../src/kernel/runner.ts';
import { executorFor } from '../src/kernel/executors.ts';
import { ServiceError } from '../src/contract/errors.ts';

const OPTS = { runs: 5, maxRuns: 100 };

test('always-pass executor yields 5 pass records with 1-based run indexes', async () => {
  const records = await executeRuns('t-pass', executorFor('always-pass'), OPTS);
  assert.equal(records.length, 5);
  assert.deepEqual(records.map((r) => r.runIndex), [1, 2, 3, 4, 5]);
  assert.ok(records.every((r) => r.outcome === 'pass'));
});

test('alternate executor fails exactly the even runs, first failure at run #2', async () => {
  const records = await executeRuns('t-alt', executorFor('alternate'), { runs: 6, maxRuns: 100 });
  assert.deepEqual(records.map((r) => r.outcome), ['pass', 'fail', 'pass', 'fail', 'pass', 'fail']);
});

test('throwing executor records a fail with the error detail, run is replayable', async () => {
  const records = await executeRuns('t-throw', () => { throw new Error('boom-42'); }, { runs: 2, maxRuns: 10 });
  assert.equal(records[0]!.outcome, 'fail');
  assert.equal(records[0]!.detail, 'boom-42');
  assert.equal(records[0]!.runIndex, 1);
});

test('runs = 0 => INPUT_ERROR', async () => {
  await assert.rejects(executeRuns('t', executorFor('always-pass'), { runs: 0, maxRuns: 100 }),
    (e: unknown) => e instanceof ServiceError && e.code === 'INPUT_ERROR');
});

test('runs above budget => RESOURCE_EXHAUSTED', async () => {
  await assert.rejects(executeRuns('t', executorFor('always-pass'), { runs: 101, maxRuns: 100 }),
    (e: unknown) => e instanceof ServiceError && e.code === 'RESOURCE_EXHAUSTED');
});

test('executor returning an invalid outcome => COMPUTATION_FAILED', async () => {
  await assert.rejects(executeRuns('t', executorFor('broken-executor'), { runs: 3, maxRuns: 10 }),
    (e: unknown) => e instanceof ServiceError && e.code === 'COMPUTATION_FAILED');
});

test('unknown pattern name => INPUT_ERROR', () => {
  assert.throws(() => executorFor('nope'), (e: unknown) => e instanceof ServiceError && e.code === 'INPUT_ERROR');
});
