// End-to-end kernel tests against the fixture projects.
// Expected scores and statuses are hand-derived from the fixture sources:
//  - killed-project:   1 arithmetic mutant, tests catch it   -> score 1
//  - survived-project: 1 arithmetic mutant, tests ignore it  -> score 0
//  - mixed-project:    3 mutants (arith killed, equality killed,
//                      console.log removal survives)         -> score 2/3
//  - broken-project:   baseline suite fails                  -> baseline_failed
//  - timeout-project:  i+1 -> i-1 loops forever              -> timeout

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MutationKernel } from '../src/kernel.ts';
import { ServiceError } from '../src/errors.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(root, 'fixtures', name);

const makeKernel = (overrides = {}) =>
  new MutationKernel({ ...DEFAULT_CONFIG, workspaceRoot: path.join(root, '.test-workspaces'), ...overrides });

test('killed-project: every mutant is killed, score is 1', async () => {
  const kernel = makeKernel();
  const report = await kernel.execute({ projectDir: fixture('killed-project'), sourceFile: 'src/calc.js' }, kernel.nextRunId());
  assert.equal(report.status, 'completed');
  assert.equal(report.total, 1);
  assert.equal(report.killed, 1);
  assert.equal(report.survived, 0);
  assert.equal(report.score, 1);
  assert.equal(report.mutants[0].mutator, 'ArithmeticFlip');
  assert.equal(report.mutants[0].status, 'killed');
  assert.match(report.mutants[0].reason, /exit=/);
  assert.ok(report.log.some((l) => l.includes('baseline: OK')));
});

test('survived-project: mutant survives, score is 0 and survivor is listed', async () => {
  const kernel = makeKernel();
  const report = await kernel.execute({ projectDir: fixture('survived-project'), sourceFile: 'src/calc.js' }, kernel.nextRunId());
  assert.equal(report.total, 1);
  assert.equal(report.killed, 0);
  assert.equal(report.survived, 1);
  assert.equal(report.score, 0);
  assert.equal(report.survivors.length, 1);
  assert.equal(report.survivors[0].id, report.mutants[0].id);
  assert.match(report.survivors[0].reason, /NOT detected/);
});

test('mixed-project: two killed, one survived, score is 2/3', async () => {
  const kernel = makeKernel();
  const report = await kernel.execute({ projectDir: fixture('mixed-project'), sourceFile: 'src/calc.js' }, kernel.nextRunId());
  assert.equal(report.total, 3);
  assert.equal(report.killed, 2);
  assert.equal(report.survived, 1);
  assert.ok(Math.abs(report.score - 2 / 3) < 1e-9);
  const byMutator = Object.fromEntries(report.mutants.map((m) => [m.mutator, m]));
  assert.equal(byMutator.ArithmeticFlip.status, 'killed');
  assert.equal(byMutator.EqualityFlip.status, 'killed');
  assert.equal(byMutator.CallRemoval.status, 'survived');
  assert.deepEqual(report.survivors.map((m) => m.mutator), ['CallRemoval']);
});

test('broken-project: failing baseline aborts the run with baseline_failed', async () => {
  const kernel = makeKernel();
  const report = await kernel.execute({ projectDir: fixture('broken-project'), sourceFile: 'src/calc.js' }, kernel.nextRunId());
  assert.equal(report.status, 'baseline_failed');
  assert.equal(report.total, 0);
  assert.equal(report.score, 0);
  assert.ok(report.log.some((l) => l.includes('baseline: FAILED')));
});

test('timeout-project: infinite-loop mutant is classified as timeout', async () => {
  const kernel = makeKernel();
  const report = await kernel.execute(
    { projectDir: fixture('timeout-project'), sourceFile: 'src/counter.js', timeoutMs: 8000 },
    kernel.nextRunId(),
  );
  assert.equal(report.status, 'completed');
  assert.equal(report.total, 1);
  assert.equal(report.timeout, 1);
  assert.equal(report.mutants[0].status, 'timeout');
  assert.match(report.mutants[0].reason, /timeoutMs=8000/);
});

test('input error: missing projectDir is rejected as INPUT_ERROR', async () => {
  const kernel = makeKernel();
  await assert.rejects(
    () => kernel.execute({ projectDir: path.join(root, 'fixtures', 'nope'), sourceFile: 'x.js' }, kernel.nextRunId()),
    (err) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.category, 'INPUT_ERROR');
      return true;
    },
  );
});

test('input error: sourceFile escaping the project is rejected', async () => {
  const kernel = makeKernel();
  await assert.rejects(
    () => kernel.execute({ projectDir: fixture('killed-project'), sourceFile: '../../etc/passwd' }, kernel.nextRunId()),
    (err) => err instanceof ServiceError && err.category === 'INPUT_ERROR',
  );
});

test('input error: unknown mutator name is rejected', async () => {
  const kernel = makeKernel();
  await assert.rejects(
    () => kernel.execute(
      { projectDir: fixture('killed-project'), sourceFile: 'src/calc.js', mutators: ['Nope'] },
      kernel.nextRunId(),
    ),
    (err) => err instanceof ServiceError && err.category === 'INPUT_ERROR' && /unknown mutator/.test(err.message),
  );
});

test('resource exhausted: timeoutMs above the configured max is rejected', async () => {
  const kernel = makeKernel({ maxTimeoutMs: 5000 });
  await assert.rejects(
    () => kernel.execute(
      { projectDir: fixture('killed-project'), sourceFile: 'src/calc.js', timeoutMs: 6000 },
      kernel.nextRunId(),
    ),
    (err) => err instanceof ServiceError && err.category === 'RESOURCE_EXHAUSTED',
  );
});

test('state conflict: a second concurrent run on the same project is rejected', async () => {
  const kernel = makeKernel();
  const req = { projectDir: fixture('mixed-project'), sourceFile: 'src/calc.js' };
  const first = kernel.execute(req, kernel.nextRunId());
  await assert.rejects(
    () => kernel.execute(req, kernel.nextRunId()),
    (err) => err instanceof ServiceError && err.category === 'STATE_CONFLICT',
  );
  const report = await first;
  assert.equal(report.status, 'completed');
});

test('run ids are unique and replayable', async () => {
  const kernel = makeKernel();
  const a = kernel.nextRunId();
  const b = kernel.nextRunId();
  assert.notEqual(a, b);
  assert.match(a, /^R-\d{8}-\d{4}$/);
});
