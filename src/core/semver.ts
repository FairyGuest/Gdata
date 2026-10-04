// Semantic version utilities. All comparisons are numeric per semver rules
// (major.minor.patch compared as integers), never lexicographic.
import { ScanError } from '../contract/errors.ts';

export interface SemVer { major: number; minor: number; patch: number; }

export function parseVersion(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new ScanError('INPUT_ERROR', 'Invalid semver "' + v + '"; expected x.y.z');
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// Returns -1, 0, 1. Numeric field-by-field comparison.
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  return 0;
}

type Comparator = { op: '>=' | '<=' | '>' | '<' | '='; version: string };

function parseComparator(token: string): Comparator {
  const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
  if (!m) throw new ScanError('INPUT_ERROR', 'Invalid range comparator "' + token + '"');
  return { op: (m[1] ?? '=') as Comparator['op'], version: m[2] };
}

function expandCaret(version: string): Comparator[] {
  const v = parseVersion(version);
  const upper = v.major > 0
    ? (v.major + 1) + '.0.0'
    : v.minor > 0
      ? '0.' + (v.minor + 1) + '.0'
      : '0.0.' + (v.patch + 1);
  return [{ op: '>=', version }, { op: '<', version: upper }];
}

function expandTilde(version: string): Comparator[] {
  const v = parseVersion(version);
  const upper = v.major + '.' + (v.minor + 1) + '.0';
  return [{ op: '>=', version }, { op: '<', version: upper }];
}

// Supported range syntax: space-separated AND of comparators
// (">=1.0.0 <2.0.0"), exact "1.2.3", "*", caret "^1.2.3", tilde "~1.2.3".
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;
  let comparators: Comparator[] = [];
  if (trimmed.startsWith('^')) {
    comparators = expandCaret(trimmed.slice(1));
  } else if (trimmed.startsWith('~')) {
    comparators = expandTilde(trimmed.slice(1));
  } else {
    comparators = trimmed.split(/\s+/).map(parseComparator);
  }
  return comparators.every((c) => {
    const cmp = compareVersions(version, c.version);
    switch (c.op) {
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '<': return cmp < 0;
      case '=': return cmp === 0;
    }
  });
}
