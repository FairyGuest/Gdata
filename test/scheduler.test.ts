import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRegistered, writeWorkspaceFile } from './helpers.ts';
import { FAILURE_MARKER } from '../src/fixtures/runner.ts';

test('fingerprint unchanged -> target skipped with reason', async (t) => {
  const { service } = makeRegistered();
  t.after(() => service.close());

  const run1 = service.submitEvents(['src/lib.ts']);
  await service.waitForIdle();
  const r1 = service.getRun(run1.runId);
  assert.deepEqual(r1.records.map((r) => [r.target, r.outcome]), [
    ['lib', 'success'], ['app', 'success'], ['extra', 'success'],
  ]);

  // Same event again, no content change: everything skips on fingerprint.
  const run2 = service.submitEvents(['src/lib.ts']);
  await service.waitForIdle();
  const r2 = service.getRun(run2.runId);
  assert.equal(r2.records.length, 3);
  for (const rec of r2.records) {
    assert.equal(rec.outcome, 'skipped');
    assert.match(rec.reason ?? '', /fingerprint unchanged/);
  }
  const skips = service.store.getSkips('lib');
  assert.equal(skips.length, 1);
  assert.equal(service.runner.count('lib'), 1, 'no second real build happened');
});

test('failed upstream blocks downstream with the upstream named', async (t) => {
  const { service, root } = makeRegistered();
  t.after(() => service.close());

  writeWorkspaceFile(root, 'src/lib.ts', FAILURE_MARKER);
  const run = service.submitEvents(['src/lib.ts']);
  await service.waitForIdle();
  const r = service.getRun(run.runId);
  const byTarget = new Map(r.records.map((rec) => [rec.target, rec]));

  assert.equal(byTarget.get('lib')?.outcome, 'failed');
  assert.match(byTarget.get('lib')?.reason ?? '', /fixture failure/);
  assert.equal(byTarget.get('app')?.outcome, 'blocked');
  assert.match(byTarget.get('app')?.reason ?? '', /upstream lib/);
  assert.equal(byTarget.get('extra')?.outcome, 'blocked');
  assert.match(byTarget.get('extra')?.reason ?? '', /upstream lib/);
  // docs was not in the affected set at all
  assert.equal(byTarget.get('docs'), undefined);
  // blocked targets never entered the queue / executor
  assert.equal(service.runner.count('app'), 0);
  assert.equal(service.runner.count('extra'), 0);
});

test('change during build merges into exactly one pending rebuild', async (t) => {
  const { service, root } = makeRegistered({ buildDelayMs: 80 });
  t.after(() => service.close());

  const run1 = service.submitEvents(['src/lib.ts']);
  // Wait until lib is actually building, then change the file again.
  for (let i = 0; i < 200; i++) {
    const s = service.getState().find((x) => x.name === 'lib');
    if (s?.state === 'building') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(service.getState().find((x) => x.name === 'lib')?.state, 'building');

  writeWorkspaceFile(root, 'src/lib.ts', 'export const lib = 2;');
  const run2 = service.submitEvents(['src/lib.ts']);
  await service.waitForIdle();

  // Second submission did not double-queue: lib was merged as pending.
  const r2 = service.getRun(run2.runId);
  const merged = r2.records.filter((rec) => rec.target === 'lib');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].outcome, 'skipped');
  assert.match(merged[0].reason ?? '', /merged: already building/);

  // Exactly two real builds of lib: the in-flight one + one merged round.
  assert.equal(service.runner.count('lib'), 2);
  // The merged round saw the new content fingerprint.
  const last = service.store.getLastBuild('lib');
  assert.equal(last?.outcome, 'success');
});

test('resource exhaustion is a distinct error category', async (t) => {
  const { service } = makeRegistered({ maxRebuildSetSize: 1 });
  t.after(() => service.close());
  assert.throws(
    () => service.submitEvents(['src/lib.ts']),
    (err: unknown) => (err as { code?: string }).code === 'RESOURCE_EXHAUSTED',
  );
});

test('input and state-conflict errors are distinct categories', async (t) => {
  const { service } = makeRegistered();
  t.after(() => service.close());
  assert.throws(
    () => service.submitEvents([]),
    (err: unknown) => (err as { code?: string }).code === 'INPUT_ERROR',
  );
  assert.throws(
    () => service.registerTargets([{ name: 'x', paths: ['x'], deps: [] }]),
    (err: unknown) => (err as { code?: string }).code === 'STATE_CONFLICT',
  );
  assert.throws(
    () => service.getRun(999),
    (err: unknown) => (err as { code?: string }).code === 'NOT_FOUND',
  );
});