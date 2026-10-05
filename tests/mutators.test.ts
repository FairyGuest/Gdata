// Unit tests for mutant generation and application.
// Expected values are hand-computed from the fixture source text,
// not derived from the implementation under test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMutants, applyMutant } from '../src/mutators.ts';
import type { MutantSpec } from '../src/contracts.ts';

const SOURCE = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function isSame(a, b) {',
  '  return a === b;',
  '}',
  '',
  'export function track(value) {',
  "  console.log('tracking', value);",
  '  return value;',
  '}',
  '',
].join('\n');

test('generates exactly one mutant per hit, of the expected types', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js');
  assert.equal(mutants.length, 3);
  const byMutator = Object.fromEntries(mutants.map((m) => [m.mutator, m]));
  assert.ok(byMutator.ArithmeticFlip);
  assert.ok(byMutator.EqualityFlip);
  assert.ok(byMutator.CallRemoval);
});

test('ArithmeticFlip targets the binary plus with exact offset and replacement', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js');
  const m = mutants.find((x) => x.mutator === 'ArithmeticFlip')!;
  const expectedOffset = SOURCE.indexOf('a + b') + 2; // the '+' itself
  assert.equal(m.offset, expectedOffset);
  assert.equal(m.original, '+');
  assert.equal(m.replacement, '-');
  assert.equal(m.length, 1);
});

test('EqualityFlip turns === into !== and back', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js');
  const m = mutants.find((x) => x.mutator === 'EqualityFlip')!;
  assert.equal(m.original, '===');
  assert.equal(m.replacement, '!==');
  const roundTrip = generateMutants('const ok = a !== b;\n', 'f.js');
  assert.equal(roundTrip[0].replacement, '===');
});

test('CallRemoval removes the whole console.log statement line', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js');
  const m = mutants.find((x) => x.mutator === 'CallRemoval')!;
  assert.equal(m.original.trim(), "console.log('tracking', value);");
  assert.equal(m.replacement, '');
});

test('ids are sequential and ordered by source offset', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js');
  assert.deepEqual(mutants.map((m) => m.id), ['M001', 'M002', 'M003']);
  const offsets = mutants.map((m) => m.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
});

test('mutator filter restricts which operators run', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js', ['EqualityFlip']);
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].mutator, 'EqualityFlip');
});

test('applyMutant splices the replacement at the recorded offset', () => {
  const mutants = generateMutants(SOURCE, 'src/calc.js');
  const arith = mutants.find((x) => x.mutator === 'ArithmeticFlip')!;
  const mutated = applyMutant(SOURCE, arith);
  assert.ok(mutated.includes('return a - b;'));
  assert.ok(!mutated.includes('return a + b;'));
  const call = mutants.find((x) => x.mutator === 'CallRemoval')!;
  const stripped = applyMutant(SOURCE, call);
  assert.ok(!stripped.includes('console.log'));
  assert.ok(stripped.includes('return value;'));
});

test('does not mutate ++, +=, or unary plus', () => {
  const src = 'let i = 0;\ni++;\ni += 2;\nconst j = +i;\n';
  const mutants = generateMutants(src, 'f.js', ['ArithmeticFlip']);
  assert.equal(mutants.length, 0);
});

test('mutant spec satisfies the MutantSpec contract shape', () => {
  const [m] = generateMutants(SOURCE, 'src/calc.js');
  const keys = Object.keys(m).sort();
  const expected: Array<keyof MutantSpec> = ['file', 'id', 'length', 'mutator', 'offset', 'original', 'preview', 'replacement'];
  assert.deepEqual(keys, expected.sort());
});
