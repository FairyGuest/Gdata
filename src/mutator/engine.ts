import type { Mutant, MutationType } from '../contract/types.ts';
import { OPERATORS, REMOVE_CALL } from './operators.ts';

interface Token {
  readonly start: number;
  readonly text: string;
}

const OPERAND_TOKENS = OPERATORS.flatMap((op) =>
  op.replacements.map(([from]) => ({ type: op.type, from })),
).sort((a, b) => b.from.length - a.from.length);

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

// Scan source into candidate mutation sites, skipping comments and strings.
export function scanTokens(source: string): Array<{ type: MutationType; token: Token }> {
  const sites: Array<{ type: MutationType; token: Token }> = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '\x60') {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    // boolean literals as whole identifiers
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && isIdentChar(source[j])) j++;
      const word = source.slice(i, j);
      if (word === 'true' || word === 'false') {
        sites.push({ type: 'BooleanLiteral', token: { start: i, text: word } });
      }
      i = j;
      continue;
    }
    // operator tokens, longest match first
    let matched = false;
    for (const cand of OPERAND_TOKENS) {
      if (cand.from === 'true' || cand.from === 'false') continue;
      if (source.startsWith(cand.from, i)) {
        const prev = i > 0 ? source[i - 1] : ' ';
        const next = i + cand.from.length < n ? source[i + cand.from.length] : ' ';
        // avoid matching '+' inside '++'/'+=' or '-' in '--'/'-='
        if ((cand.from === '+' || cand.from === '-') &&
            (next === cand.from || prev === cand.from || next === '=')) break;
        if ((cand.from === '-' || cand.from === '>') && prev === '=') break; // arrow '=>'
        if (!isIdentChar(prev) || cand.from.length > 1) {
          sites.push({ type: cand.type, token: { start: i, text: cand.from } });
          i += cand.from.length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) i++;
  }
  return sites;
}

// Detect standalone call statements like foo(a, b); or obj.m(x); whose
// deletion yields a RemoveCall mutant. Returns statement spans.
export function scanCallStatements(source: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const re = /^[ \t]*(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^;{}]*\);[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const text = m[0].trim();
    if (/^(if|for|while|switch|return|throw|catch)\b/.test(text)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

function lineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') { line++; last = i; }
  }
  return { line, column: offset - last };
}

export function generateMutants(
  file: string,
  source: string,
  filterTypes?: ReadonlyArray<MutationType>,
): Mutant[] {
  const enabled = filterTypes && filterTypes.length > 0 ? new Set(filterTypes) : null;
  const mutants: Mutant[] = [];
  for (const site of scanTokens(source)) {
    if (enabled && !enabled.has(site.type)) continue;
    const op = OPERATORS.find((o) => o.type === site.type)!;
    const pair = op.replacements.find(([from]) => from === site.token.text);
    if (!pair) continue;
    const { line, column } = lineCol(source, site.token.start);
    mutants.push({
      id: file + ':' + site.token.start + ':' + site.type + ':0',
      file,
      offset: site.token.start,
      line,
      column,
      type: site.type,
      original: pair[0],
      replacement: pair[1],
    });
  }
  if (!enabled || enabled.has(REMOVE_CALL.type)) {
    let idx = 0;
    for (const span of scanCallStatements(source)) {
      const { line, column } = lineCol(source, span.start);
      mutants.push({
        id: file + ':' + span.start + ':RemoveCall:' + idx++,
        file,
        offset: span.start,
        line,
        column,
        type: 'RemoveCall',
        original: span.text.trim(),
        replacement: '/* removed */',
      });
    }
  }
  return mutants.sort((a, b) => a.offset - b.offset || a.type.localeCompare(b.type));
}

