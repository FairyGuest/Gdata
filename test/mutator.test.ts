import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMutants, scanCallStatements } from '../src/mutator/engine.ts';
import { applyMutant } from '../src/mutator/apply.ts';
import { ServiceError } from '../src/contract/errors.ts';

test('generates equality and arithmetic mutants at correct offsets', () => {
  const src = 'const ok = a === b;\nconst sum = a + b;\n';
  const mutants = generateMutants('f.js', src);
  assert.equal(mutants.length, 2);
  const eq = mutants.find((m) => m.type === 'EqualityOperator')!;
  assert.equal(eq.original, '===');
  assert.equal(eq.replacement, '!==');
  assert.equal(src.slice(eq.offset, eq.offset + 3), '===');
  const ar = mutants.find((m) => m.type === 'ArithmeticOperator')!;
  assert.equal(ar.original, '+');
  assert.equal(ar.replacement, '-');
});

test('skips operators inside strings and comments', () => {
  const src = 'const s = "a === b";\n// x + y\n/* p * q */\nconst t = a < b;\n';
  const mutants = generateMutants('f.js', src);
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].type, 'ConditionalBoundary');
  assert.equal(mutants[0].original, '<');
  assert.equal(mutants[0].replacement, '<=');
});

test('longest match wins: <= is one mutant, not < then =', () => {
  const mutants = generateMutants('f.js', 'if (a <= b) {}\n');
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].original, '<=');
  assert.equal(mutants[0].replacement, '<');
});

test('does not mutate ++, +=, or arrow functions', () => {
  const mutants = generateMutants('f.js', 'let i = 0;\ni++;\ni += 2;\nconst f = (x) => x;\n');
  assert.equal(mutants.length, 0);
});

test('detects removable call statements but not control flow', () => {
  const src = 'function g() {\n  log.info("hi");\n  if (x) {}\n  return compute(1);\n}\n';
  const spans = scanCallStatements(src);
  assert.equal(spans.length, 1);
  assert.ok(spans[0].text.includes('log.info("hi");'));
});

test('type filter restricts generated mutants', () => {
  const src = 'const a = x === y;\nconst b = p + q;\n';
  const mutants = generateMutants('f.js', src, ['EqualityOperator']);
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].type, 'EqualityOperator');
});

test('applyMutant replaces the exact token', () => {
  const src = 'return a === b;';
  const [m] = generateMutants('f.js', src);
  assert.equal(applyMutant(src, m), 'return a !== b;');
});

test('applyMutant removes a call statement', () => {
  const src = 'function f() {\n  cleanup();\n  return 1;\n}\n';
  const m = generateMutants('f.js', src).find((x) => x.type === 'RemoveCall')!;
  const out = applyMutant(src, m);
  assert.ok(!out.includes('cleanup();'));
  assert.ok(out.includes('/* removed */'));
});

test('applyMutant reports STATE_CONFLICT on drifted source', () => {
  const src = 'return a === b;';
  const [m] = generateMutants('f.js', src);
  assert.throws(() => applyMutant('return a == b;', m),
    (err: unknown) => err instanceof ServiceError && (err as ServiceError).code === 'STATE_CONFLICT');
});

