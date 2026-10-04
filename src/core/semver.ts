// 语义化版本：严格按 major.minor.patch 数值比较，禁止字符串字典序。
import { ScanError } from '../contract/errors.ts';

export interface SemVer { major: number; minor: number; patch: number; }

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(v: string): SemVer {
  const m = VERSION_RE.exec(v.trim());
  if (!m) throw new ScanError('INPUT_ERROR', `invalid semver version: "${v}" (expected major.minor.patch)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isValidSemver(v: string): boolean {
  return VERSION_RE.test(v.trim());
}

// 数值比较：-1 / 0 / 1
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function compareVersions(a: string, b: string): number {
  return compareSemver(parseSemver(a), parseSemver(b));
}

interface Comparator { op: '>=' | '<=' | '>' | '<' | '='; version: SemVer; }

// 支持的范围语法（空格分隔为 AND）：
//   "*" | "1.2.3" | "=1.2.3" | ">=1.0.0 <2.0.0" | "^1.2.3" | "~1.2.3"
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  const r = range.trim();
  if (r === '' || r === '*') return true;
  for (const token of r.split(/\s+/)) {
    for (const cmp of parseComparator(token)) {
      const c = compareSemver(v, cmp.version);
      const ok =
        cmp.op === '>=' ? c >= 0 :
        cmp.op === '<=' ? c <= 0 :
        cmp.op === '>'  ? c >  0 :
        cmp.op === '<'  ? c <  0 :
                          c === 0;
      if (!ok) return false;
    }
  }
  return true;
}

function parseComparator(token: string): Comparator[] {
  if (token.startsWith('^')) {
    const base = parsePartial(token.slice(1));
    const upper: SemVer = base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0 }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: base.patch + 1 };
    return [{ op: '>=', version: base }, { op: '<', version: upper }];
  }
  if (token.startsWith('~')) {
    const base = parsePartial(token.slice(1));
    const upper: SemVer = { major: base.major, minor: base.minor + 1, patch: 0 };
    return [{ op: '>=', version: base }, { op: '<', version: upper }];
  }
  const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(token);
  if (!m) throw new ScanError('INPUT_ERROR', `invalid version range token: "${token}"`);
  const op = (m[1] ?? '=') as Comparator['op'];
  return [{ op, version: parsePartial(m[2]) }];
}

function parsePartial(s: string): SemVer {
  const parts = s.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}
