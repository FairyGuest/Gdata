// State adapter tests: persistence, conflict categories, and run-to-run diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LintStore } from '../src/state/store.ts';
import { LintEngine } from '../src/core/engine.ts';
import { EngineError } from '../src/contracts/errors.ts';
import type { Rule } from '../src/contracts/types.ts';

const LIMITS = { maxSourceBytes: 1 << 20, maxFilesPerCheck: 10, maxMatchesPerRule: 100, maxRules: 50 };
const RULES: Rule[] = [
  { name: 'no-eval', enabled: true, severity: 'error', target: { kind: 'regex', pattern: '\\beval\\s*\\(' } },
  { name: 'no-todo', enabled: true, severity: 'warning', target: { kind: 'regex', pattern: 'TODO' } },
];

function run(store: LintStore, content: string): number {
  const engine = new LintEngine({ limits: LIMITS });
  const res = engine.check([{ path: 'app.ts', content }], RULES);
  return store.saveRun(res.filesChecked, res.violations);
}

test('rule CRUD and enable/disable', () => {
  const store = new LintStore(':memory:');
  store.addRule({ name: 'r1', severity: 'warning', target: { kind: 'regex', pattern: 'x' } });
  assert.equal(store.listRules().length, 1);
  assert.equal(store.getRule('r1').enabled, true);
  store.setRuleEnabled('r1', false);
  assert.equal(store.getRule('r1').enabled, false);
  store.deleteRule('r1');
  assert.equal(store.listRules().length, 0);
  store.close();
});

test('duplicate rule name is STATE_CONFLICT', () => {
  const store = new LintStore(':memory:');
  store.addRule({ name: 'dup', severity: 'info', target: { kind: 'regex', pattern: 'x' } });
  assert.throws(() => store.addRule({ name: 'dup', severity: 'info', target: { kind: 'regex', pattern: 'y' } }), (err: unknown) => {
    assert.equal((err as EngineError).category, 'STATE_CONFLICT');
    return true;
  });
  store.close();
});

test('missing rule and missing run are NOT_FOUND', () => {
  const store = new LintStore(':memory:');
  assert.throws(() => store.getRule('ghost'), (e: unknown) => (assert.equal((e as EngineError).category, 'NOT_FOUND'), true));
  assert.throws(() => store.getRun(999), (e: unknown) => (assert.equal((e as EngineError).category, 'NOT_FOUND'), true));
  store.close();
});

test('diff between two runs reports added and removed violations', () => {
  const store = new LintStore(':memory:');
  const v1 = 'const a = eval("1"); // TODO: remove\n';
  const v2 = 'const a = 1;\nconst b = eval("2");\n';
  const run1 = run(store, v1);
  const run2 = run(store, v2);
  const diff = store.diffRuns(run1, run2);

  // v1 -> v2: the line-1 eval and the TODO disappear; a new eval appears on line 2.
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].rule, 'no-eval');
  assert.equal(diff.added[0].line, 2);
  assert.equal(diff.removed.length, 2);
  assert.deepEqual(diff.removed.map((v) => v.rule).sort(), ['no-eval', 'no-todo']);

  // identical re-check produces an empty diff
  const run3 = run(store, v2);
  const empty = store.diffRuns(run2, run3);
  assert.equal(empty.added.length, 0);
  assert.equal(empty.removed.length, 0);
  store.close();
});

test('run summaries are listed in order', () => {
  const store = new LintStore(':memory:');
  const a = run(store, 'eval(1);\n');
  const b = run(store, 'eval(2);\n');
  const runs = store.listRuns();
  assert.deepEqual(runs.map((r) => r.id), [a, b]);
  assert.equal(runs[0].violationCount, 1);
  assert.equal(runs[0].status, 'completed');
  store.close();
});
