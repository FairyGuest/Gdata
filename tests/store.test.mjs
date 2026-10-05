import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../dist/store.js';

function sampleRun(id, startedAt) {
  return {
    runId: id,
    startedAt,
    finishedAt: startedAt,
    durationMs: 10,
    total: 2,
    passed: 1,
    failed: 1,
    timeout: 0,
    status: 'partial',
    logs: ['log-line'],
    results: [
      { file: 'pass.test.js', case: 'c1', status: 'passed', durationMs: 5, reason: 'ok' },
      { file: 'fail.test.js', case: 'c2', status: 'failed', failureKind: 'assertion', error: 'boom', durationMs: 5, reason: 'bad' },
    ],
  };
}

test('保存后可按 runId 取回完整结果', () => {
  const store = new RunStore(':memory:');
  store.saveRun(sampleRun('r1', '2026-01-01T00:00:00.000Z'));
  const run = store.getRun('r1');
  assert.equal(run.status, 'partial');
  assert.equal(run.results.length, 2);
  assert.equal(run.results[1].failureKind, 'assertion');
  assert.deepEqual(run.logs, ['log-line']);
  assert.equal(store.getRun('nope'), undefined);
  store.close();
});

test('按文件名与时间范围查询', () => {
  const store = new RunStore(':memory:');
  store.saveRun(sampleRun('r1', '2026-01-01T00:00:00.000Z'));
  store.saveRun(sampleRun('r2', '2026-02-01T00:00:00.000Z'));
  assert.deepEqual(store.queryRuns({ file: 'fail' }).map((r) => r.runId).sort(), ['r1', 'r2']);
  assert.deepEqual(store.queryRuns({ file: 'nonexistent' }), []);
  assert.deepEqual(store.queryRuns({ from: '2026-01-15' }).map((r) => r.runId), ['r2']);
  assert.deepEqual(store.queryRuns({ to: '2026-01-15' }).map((r) => r.runId), ['r1']);
  assert.throws(() => store.queryRuns({ from: 'not-a-date' }), (e) => e.code === 'INVALID_INPUT');
  store.close();
});