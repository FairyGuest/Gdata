import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeAll } from '../dist/executor.js';

const DIR = 'fixtures/sample';
const OPTS = { dir: DIR, parallel: true, concurrency: 4, timeoutMs: 2000, maxConcurrency: 8, dependencies: {} };

test('正常通过的用例状态为 passed', async () => {
  const results = await executeAll({
    ...OPTS,
    files: ['pass.test.js'],
    orderedFiles: ['pass.test.js'],
  });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.status, 'passed', r.case + ' 应通过: ' + (r.error ?? ''));
    assert.ok(r.durationMs >= 0);
  }
});

test('断言失败与运行时异常被区分，同文件其他用例不受影响', async () => {
  const results = await executeAll({
    ...OPTS,
    files: ['fail.test.js'],
    orderedFiles: ['fail.test.js'],
  });
  const byCase = new Map(results.map((r) => [r.case, r]));
  assert.equal(byCase.get('断言失败用例').status, 'failed');
  assert.equal(byCase.get('断言失败用例').failureKind, 'assertion');
  assert.match(byCase.get('断言失败用例').error, /数学没有崩坏/);
  assert.equal(byCase.get('运行时异常用例').status, 'failed');
  assert.equal(byCase.get('运行时异常用例').failureKind, 'runtime');
  assert.match(byCase.get('运行时异常用例').error, /TypeError/);
  assert.equal(byCase.get('同文件内其他用例不受影响').status, 'passed');
});

test('超时用例被终止且不阻塞同文件其他用例', async () => {
  const started = Date.now();
  const results = await executeAll({
    ...OPTS,
    files: ['timeout.test.js'],
    orderedFiles: ['timeout.test.js'],
    timeoutMs: 800,
  });
  const elapsed = Date.now() - started;
  const byCase = new Map(results.map((r) => [r.case, r]));
  const dead = byCase.get('永不结束的用例');
  assert.equal(dead.status, 'timeout');
  assert.equal(dead.failureKind, 'timeout');
  assert.ok(dead.durationMs >= 700, '实际耗时应接近超时上限: ' + dead.durationMs);
  assert.ok(dead.durationMs < 5000, '超时后应被迅速终止: ' + dead.durationMs);
  assert.equal(byCase.get('快速通过的邻居用例').status, 'passed');
  assert.ok(elapsed < 8000, '整体不应被超时用例拖死: ' + elapsed);
});

test('并行执行比顺序快且互不干扰', async () => {
  const files = ['parallel-a.test.js', 'parallel-b.test.js'];
  const par = await executeAll({ ...OPTS, files, orderedFiles: files, parallel: true, concurrency: 2 });
  assert.ok(par.every((r) => r.status === 'passed'), JSON.stringify(par));
  const parWall = Math.max(...par.map((r) => r.durationMs));
  assert.ok(parWall < 800, '并行时每个用例耗时应接近自身睡眠时长: ' + parWall);
});

test('并发数超过上限报 RESOURCE_EXHAUSTED', async () => {
  await assert.rejects(
    () =>
      executeAll({
        ...OPTS,
        files: ['pass.test.js'],
        orderedFiles: ['pass.test.js'],
        concurrency: 99,
      }),
    (e) => e.code === 'RESOURCE_EXHAUSTED',
  );
});
test('依赖分层：被依赖文件先执行完成', async () => {
  const events = [];
  const files = ['parallel-a.test.js', 'parallel-b.test.js'];
  await executeAll({
    ...OPTS,
    files,
    orderedFiles: ['parallel-a.test.js', 'parallel-b.test.js'],
    dependencies: { 'parallel-b.test.js': ['parallel-a.test.js'] },
    onLog: (m) => events.push(m),
  });
  const aIdx = events.findIndex((m) => m.includes('parallel-a.test.js ::'));
  const bIdx = events.findIndex((m) => m.includes('parallel-b.test.js ::'));
  assert.ok(aIdx !== -1 && bIdx !== -1 && aIdx < bIdx, 'A 应先于 B 完成: ' + events.join(' | '));
});
