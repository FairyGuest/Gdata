// Mutation operators. Each operator scans source text and emits MutantSpecs
// keyed by absolute character offset. Multiple operators may fire at the same
// location, producing several distinct mutants for one position.

import type { MutantSpec, MutatorType } from './contracts.ts';

export const ALL_MUTATORS: MutatorType[] = ['EqualityFlip', 'ArithmeticFlip', 'CallRemoval'];

interface RawHit {
  mutator: MutatorType;
  offset: number;
  length: number;
  replacement: string;
  original: string;
}

const EQUALITY_RE = /===|!==/g;
// Binary '+' between operand-ish tokens; excludes ++, +=, unary plus.
const ARITH_RE = /(?<=[\w$)\]"'][ \t]*)\+(?![+=])(?=[ \t]*[\w$("'\[])/g;
// A whole-line expression statement that is a (possibly dotted) function call.
const CALL_RE = /^[ \t]*(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\([^;{}]*\);?[ \t]*(?:\r?\n|$)/gm;

const scan = (source: string, mutators: MutatorType[]): RawHit[] => {
  const hits: RawHit[] = [];
  if (mutators.includes('EqualityFlip')) {
    for (const m of source.matchAll(EQUALITY_RE)) {
      const original = m[0];
      hits.push({
        mutator: 'EqualityFlip',
        offset: m.index,
        length: original.length,
        replacement: original === '===' ? '!==' : '===',
        original,
      });
    }
  }
  if (mutators.includes('ArithmeticFlip')) {
    for (const m of source.matchAll(ARITH_RE)) {
      const original = m[0];
      hits.push({
        mutator: 'ArithmeticFlip',
        offset: m.index,
        length: original.length,
        replacement: original.replace('+', '-'),
        original,
      });
    }
  }
  if (mutators.includes('CallRemoval')) {
    for (const m of source.matchAll(CALL_RE)) {
      const original = m[0];
      hits.push({
        mutator: 'CallRemoval',
        offset: m.index,
        length: original.length,
        replacement: '',
        original,
      });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset || a.mutator.localeCompare(b.mutator));
};

const previewOf = (source: string, hit: RawHit): string => {
  const lineStart = source.lastIndexOf('\n', hit.offset - 1) + 1;
  let lineEnd = source.indexOf('\n', hit.offset);
  if (lineEnd === -1) lineEnd = source.length;
  const before = source.slice(lineStart, lineEnd).trim();
  const after = (source.slice(lineStart, hit.offset) + hit.replacement + source.slice(hit.offset + hit.length, lineEnd)).trim();
  return before + '  =>  ' + after;
};

export const generateMutants = (
  source: string,
  file: string,
  mutators: MutatorType[] = ALL_MUTATORS,
): MutantSpec[] =>
  scan(source, mutators).map((hit, i) => ({
    id: 'M' + String(i + 1).padStart(3, '0'),
    mutator: hit.mutator,
    file,
    offset: hit.offset,
    length: hit.length,
    replacement: hit.replacement,
    original: hit.original,
    preview: previewOf(source, hit),
  }));

export const applyMutant = (source: string, mutant: MutantSpec): string =>
  source.slice(0, mutant.offset) + mutant.replacement + source.slice(mutant.offset + mutant.length);
