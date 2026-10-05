import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptCaseOutcome } from '../dist/statusAdapter.js';

const base = { file: 'f.test.js', case: 'c', durationMs: 10, stderr: '' };

test('退出码0 + ok:true => passed', () => {
  const r = adaptCaseOutcome({ ...base, exitCode: 0, timedOut: false, stdout: '{"ok":true}\n' });
  assert.equal(r.status, 'passed');
  assert.equal(r.failureKind, undefined);
});

test('断言失败 => failed/assertion，保留错误首行', () => {
  const stdout = '{"ok":false,"kind":"assertion","error":"AssertionError: boom\\n  at x"}\n';
  const r = adaptCaseOutcome({ ...base, exitCode: 1, timedOut: false, stdout });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureKind, 'assertion');
  assert.match(r.error, /AssertionError/);
});

test('运行时异常 => failed/runtime', () => {
  const stdout = '{"ok":false,"kind":"runtime","error":"TypeError: x"}\n';
  const r = adaptCaseOutcome({ ...base, exitCode: 1, timedOut: false, stdout });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureKind, 'runtime');
});

test('超时 => timeout，耗时为实际耗时', () => {
  const r = adaptCaseOutcome({ ...base, exitCode: null, timedOut: true, durationMs: 812, stdout: '' });
  assert.equal(r.status, 'timeout');
  assert.equal(r.failureKind, 'timeout');
  assert.equal(r.durationMs, 812);
});

test('无 JSON 输出且非零退出 => failed/crash（绝不吞成成功）', () => {
  const r = adaptCaseOutcome({ ...base, exitCode: 134, timedOut: false, stdout: '', stderr: 'segfault\n' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureKind, 'crash');
});

test('ok:true 但退出码非零 => 按失败处理', () => {
  const r = adaptCaseOutcome({ ...base, exitCode: 3, timedOut: false, stdout: '{"ok":true}\n' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureKind, 'crash');
});

test('测试文件自身的 console.log 不干扰结果解析', () => {
  const stdout = 'hello from test\n{"ok":true}\n';
  const r = adaptCaseOutcome({ ...base, exitCode: 0, timedOut: false, stdout });
  assert.equal(r.status, 'passed');
});