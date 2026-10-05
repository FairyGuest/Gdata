// Core engine tests: regex hits, AST node-type matching, same-position
// severity ordering, and error categories. Expected values are hand-written
// reference answers, not derived from the implementation under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LintEngine } from '../src/core/engine.ts';
import { parseSource } from '../src/core/parser.ts';
import { EngineError } from '../src/contracts/errors.ts';
import type { Rule } from '../src/contracts/types.ts';

const LIMITS = { maxSourceBytes: 1024 * 1024, maxFilesPerCheck: 10, maxMatchesPerRule: 100, maxRules: 50 };

function engine() { return new LintEngine({ limits: LIMITS }); }

test('regex rule hits the specified pattern with exact locations', () => {
  const rules: Rule[] = [{
    name: 'no-eval', enabled: true, severity: 'error',
    target: { kind: 'regex', pattern: '\\beval\\s*\\(' }, message: 'eval() is forbidden',
  }];
  const res = engine().check([{ path: 'src/a.ts', content: 'const a = 1;\nconst b = eval("x");\nconst c = eval( y );\n' }], rules);
  assert.equal(res.violations.length, 2);
  assert.deepEqual(
    res.violations.map((v) => [v.file, v.line, v.column, v.rule, v.severity]),
    [
      ['src/a.ts', 2, 11, 'no-eval', 'error'],
      ['src/a.ts', 3, 11, 'no-eval', 'error'],
    ],
  );
  assert.equal(res.violations[0].message, 'eval() is forbidden');
  assert.equal(res.violations[0].excerpt, 'const b = eval("x");');
});

test('AST node-type rule matches import statements and string literals', () => {
  const rules: Rule[] = [
    { name: 'imports', enabled: true, severity: 'info', target: { kind: 'node', nodeType: 'import_statement' } },
    { name: 'strings', enabled: true, severity: 'info', target: { kind: 'node', nodeType: 'string_literal' } },
  ];
  const src = 'import { x } from "./mod";\nconst s = "hello";\n// a comment\nfunction f() { return 1; }\n';
  const res = engine().check([{ path: 'b.ts', content: src }], rules);
  const byRule = (n: string) => res.violations.filter((v) => v.rule === n);
  assert.equal(byRule('imports').length, 1);
  assert.equal(byRule('imports')[0].line, 1);
  assert.equal(byRule('strings').length, 2); // "./mod" and "hello"
  assert.deepEqual(byRule('strings').map((v) => v.line), [1, 2]);
});

test('node rule with pattern only matches matching nodes', () => {
  const rules: Rule[] = [{
    name: 'no-var', enabled: true, severity: 'warning',
    target: { kind: 'node', nodeType: 'variable_declaration', pattern: '^\\s*var\\b' },
  }];
  const src = 'var a = 1;\nlet b = 2;\nconst c = 3;\n';
  const res = engine().check([{ path: 'c.ts', content: src }], rules);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].line, 1);
});

test('parser recognizes function declarations and comments', () => {
  const nodes = parseSource('d.ts', 'function add(a: number, b: number) {\n  // sum\n  return a + b;\n}\n');
  const types = nodes.map((n) => n.type);
  assert.ok(types.includes('function_declaration'));
  assert.ok(types.includes('comment'));
  const fn = nodes.find((n) => n.type === 'function_declaration');
  assert.equal(fn?.line, 1);
});

test('multiple rules at the same position sort by severity desc', () => {
  const rules: Rule[] = [
    { name: 'r-info', enabled: true, severity: 'info', target: { kind: 'regex', pattern: 'danger' } },
    { name: 'r-error', enabled: true, severity: 'error', target: { kind: 'regex', pattern: 'danger' } },
    { name: 'r-warning', enabled: true, severity: 'warning', target: { kind: 'regex', pattern: 'danger' } },
  ];
  const res = engine().check([{ path: 'e.ts', content: 'const x = danger;\n' }], rules);
  assert.deepEqual(res.violations.map((v) => v.rule), ['r-error', 'r-warning', 'r-info']);
});

test('disabled rules are not evaluated', () => {
  const rules: Rule[] = [
    { name: 'off', enabled: false, severity: 'error', target: { kind: 'regex', pattern: 'danger' } },
  ];
  const res = engine().check([{ path: 'f.ts', content: 'danger danger\n' }], rules);
  assert.equal(res.violations.length, 0);
  assert.equal(res.rulesEvaluated, 0);
});

test('invalid regex is an INPUT_ERROR', () => {
  const rules = [{ name: 'bad', enabled: true, severity: 'error', target: { kind: 'regex', pattern: '([' } }] as unknown as Rule[];
  assert.throws(() => engine().check([{ path: 'g.ts', content: 'x' }], rules), (err: unknown) => {
    assert.ok(err instanceof EngineError);
    assert.equal((err as EngineError).category, 'INPUT_ERROR');
    return true;
  });
});

test('unknown node type is an INPUT_ERROR', () => {
  const rules = [{ name: 'bad-node', enabled: true, severity: 'error', target: { kind: 'node', nodeType: 'nope' } }] as unknown as Rule[];
  assert.throws(() => engine().check([{ path: 'h.ts', content: 'x' }], rules), (err: unknown) => {
    assert.equal((err as EngineError).category, 'INPUT_ERROR');
    return true;
  });
});

test('oversized source is RESOURCE_EXHAUSTED', () => {
  const tiny = new LintEngine({ limits: { ...LIMITS, maxSourceBytes: 8 } });
  assert.throws(() => tiny.check([{ path: 'big.ts', content: 'const x = 123456789;' }], []), (err: unknown) => {
    assert.equal((err as EngineError).category, 'RESOURCE_EXHAUSTED');
    return true;
  });
});

test('too many matches is RESOURCE_EXHAUSTED', () => {
  const tiny = new LintEngine({ limits: { ...LIMITS, maxMatchesPerRule: 2 } });
  const rules: Rule[] = [{ name: 'many', enabled: true, severity: 'info', target: { kind: 'regex', pattern: 'a' } }];
  assert.throws(() => tiny.check([{ path: 'i.ts', content: 'a a a a a' }], rules), (err: unknown) => {
    assert.equal((err as EngineError).category, 'RESOURCE_EXHAUSTED');
    return true;
  });
});

test('empty files array is INPUT_ERROR', () => {
  assert.throws(() => engine().check([], []), (err: unknown) => {
    assert.equal((err as EngineError).category, 'INPUT_ERROR');
    return true;
  });
});
