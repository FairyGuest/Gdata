import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, validateRuleSet, DEFAULT_LIMITS } from '../src/core/engine.ts';
import { EngineError } from '../src/contracts/errors.ts';
import type { Rule } from '../src/contracts/types.ts';

const regexRule = (name: string, pattern: string, severity: Rule['severity'], enabled = true): Rule => ({
  name, enabled, severity, message: name + ' hit', match: { kind: 'regex', pattern },
});

test('regex rule hits expected positions', () => {
  const source = 'const a = "foo";\nconst b = "foo";\n';
  const result = runCheck('a.ts', source, [regexRule('no-foo', '"foo"', 'warning')]);
  assert.equal(result.violations.length, 2);
  assert.deepEqual(
    result.violations.map((v) => [v.line, v.column, v.rule, v.snippet]),
    [[1, 11, 'no-foo', '"foo"'], [2, 11, 'no-foo', '"foo"']],
  );
  assert.ok(result.log.some((e) => e.step === 'rule' && e.detail.includes('no-foo') && e.detail.includes('matches=2')));
});

test('ast FunctionDeclaration matching', () => {
  const source = 'function foo() {}\nconst x = 1;\nexport function bar() {}\n';
  const rule: Rule = { name: 'fn-names', enabled: true, severity: 'info', message: 'fn', match: { kind: 'ast', nodeType: 'FunctionDeclaration' } };
  const result = runCheck('b.ts', source, [rule]);
  assert.deepEqual(result.violations.map((v) => [v.line, v.snippet]), [[1, 'foo'], [3, 'bar']]);
});

test('ast ImportStatement with pattern filter', () => {
  const source = 'import a from "lodash";\nimport b from "./local";\n';
  const rule: Rule = { name: 'no-lodash', enabled: true, severity: 'error', message: 'no lodash', match: { kind: 'ast', nodeType: 'ImportStatement', pattern: 'lodash' } };
  const result = runCheck('c.ts', source, [rule]);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].line, 1);
});

test('ast StringLiteral matching', () => {
  const source = 'const s = "secret" + \'x\';\n';
  const rule: Rule = { name: 'str', enabled: true, severity: 'info', message: 'str', match: { kind: 'ast', nodeType: 'StringLiteral' } };
  const result = runCheck('d.ts', source, [rule]);
  assert.deepEqual(result.violations.map((v) => v.snippet), ['"secret"', "'x'"]);
});

test('multiple rules at same position sorted by severity desc', () => {
  const source = 'eval("1+1");\n';
  const rules = [
    regexRule('eval-info', 'eval', 'info'),
    regexRule('eval-error', 'eval', 'error'),
    regexRule('eval-warning', 'eval', 'warning'),
  ];
  const result = runCheck('e.ts', source, rules);
  assert.equal(result.violations.length, 3);
  assert.deepEqual(
    result.violations.map((v) => [v.rule, v.severity]),
    [['eval-error', 'error'], ['eval-warning', 'warning'], ['eval-info', 'info']],
  );
  assert.ok(result.violations.every((v) => v.line === 1 && v.column === 1));
});

test('disabled rules are skipped', () => {
  const result = runCheck('f.ts', 'eval("x");\n', [regexRule('off', 'eval', 'error', false)]);
  assert.equal(result.violations.length, 0);
  assert.ok(result.log.some((e) => e.step === 'rules' && e.detail.includes('disabled=1')));
});

test('invalid regex rejected as INPUT_ERROR', () => {
  assert.throws(
    () => validateRuleSet([{ name: 'bad', enabled: true, severity: 'error', message: 'm', match: { kind: 'regex', pattern: '([' } }]),
    (e: unknown) => e instanceof EngineError && e.category === 'INPUT_ERROR' && e.code === 'RULE_REGEX_INVALID',
  );
});

test('duplicate rule name rejected as STATE_CONFLICT', () => {
  assert.throws(
    () => validateRuleSet([regexRule('dup', 'a', 'error'), regexRule('dup', 'b', 'warning')]),
    (e: unknown) => e instanceof EngineError && e.category === 'STATE_CONFLICT' && e.code === 'RULE_DUPLICATE',
  );
});

test('oversized source rejected as RESOURCE_EXHAUSTED', () => {
  const limits = { ...DEFAULT_LIMITS, maxSourceBytes: 10 };
  assert.throws(
    () => runCheck('big.ts', 'x'.repeat(100), [], limits),
    (e: unknown) => e instanceof EngineError && e.category === 'RESOURCE_EXHAUSTED' && e.code === 'SOURCE_TOO_LARGE',
  );
});

test('unknown ast node type rejected as INPUT_ERROR', () => {
  assert.throws(
    () => validateRuleSet([{ name: 'x', enabled: true, severity: 'info', message: 'm', match: { kind: 'ast', nodeType: 'ClassDecl' } }]),
    (e: unknown) => e instanceof EngineError && e.category === 'INPUT_ERROR' && e.code === 'RULE_NODETYPE_INVALID',
  );
});

