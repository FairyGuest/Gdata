import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Store } from '../src/state/store.ts';
import { runCheck } from '../src/core/engine.ts';
import { EngineError } from '../src/contracts/errors.ts';
import type { Rule } from '../src/contracts/types.ts';

const noConsole: Rule = { name: 'no-console', enabled: true, severity: 'warning', message: 'no console', match: { kind: 'regex', pattern: 'console\\.log' } };
const noEval: Rule = { name: 'no-eval', enabled: true, severity: 'error', message: 'no eval', match: { kind: 'regex', pattern: 'eval\\(' } };

test('diff between two runs reports added and removed violations', () => {
  const store = new Store(':memory:');
  store.replaceRules([noConsole, noEval]);

  const run1 = runCheck('app.ts', 'console.log("a");\neval("1");\n', store.listRules());
  store.saveRun(run1.runId, run1.file, run1.violations, run1.log);

  const run2 = runCheck('app.ts', 'console.log("a");\nconst x = 1;\nconsole.log("b");\n', store.listRules());
  store.saveRun(run2.runId, run2.file, run2.violations, run2.log);

  const diff = store.diff(run1.runId, run2.runId);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].rule, 'no-console');
  assert.equal(diff.added[0].line, 3);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].rule, 'no-eval');
  assert.equal(diff.removed[0].line, 2);
  store.close();
});

test('run lookup of missing id throws NOT_FOUND', () => {
  const store = new Store(':memory:');
  assert.throws(
    () => store.getRun('run-nope'),
    (e: unknown) => e instanceof EngineError && e.category === 'NOT_FOUND' && e.code === 'RUN_NOT_FOUND',
  );
  store.close();
});

test('addRule duplicate throws STATE_CONFLICT, setEnabled on missing throws NOT_FOUND', () => {
  const store = new Store(':memory:');
  store.addRule(noConsole);
  assert.throws(
    () => store.addRule(noConsole),
    (e: unknown) => e instanceof EngineError && e.category === 'STATE_CONFLICT' && e.code === 'RULE_EXISTS',
  );
  assert.throws(
    () => store.setRuleEnabled('ghost', true),
    (e: unknown) => e instanceof EngineError && e.category === 'NOT_FOUND' && e.code === 'RULE_NOT_FOUND',
  );
  store.setRuleEnabled('no-console', false);
  assert.equal(store.listRules()[0].enabled, false);
  store.close();
});

test('rules persist across store instances (file db)', () => {
  const path = 'test/.tmp-store-' + process.pid + '.db';
  const s1 = new Store(path);
  s1.replaceRules([noEval]);
  s1.close();
  const s2 = new Store(path);
  assert.deepEqual(s2.listRules().map((r) => r.name), ['no-eval']);
  s2.close();
  rmSync(path, { force: true });
});

