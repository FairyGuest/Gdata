// Execution kernel: structured drift comparison between the effective
// configuration (expected) and the runtime snapshot (actual).
// Categories by severity: missing (required key absent) > mismatch (value
// differs) > extra (snapshot-only key). Items sort by severity rank, then by
// dot-path lexicographically for a stable order.
import { isPlainObject } from '../contract/validate.ts';
import type { DriftCategory, DriftItem, DriftReport, JsonObject, JsonValue } from '../contract/types.ts';

const CATEGORY_RANK: Record<DriftCategory, number> = { missing: 0, mismatch: 1, extra: 2 };

function valuesEqual(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    // objects are handled by structural recursion in collect(), never reach here
    return false;
  }
  return a === b;
}

function collect(expected: JsonObject, actual: JsonObject, prefix: string, out: DriftItem[]): void {
  for (const [key, expVal] of Object.entries(expected)) {
    const path = prefix === '' ? key : prefix + '.' + key;
    if (!(key in actual)) {
      out.push({ path, category: 'missing', expected: expVal, reason: 'required key absent from snapshot' });
      continue;
    }
    const actVal = actual[key];
    if (isPlainObject(expVal) && isPlainObject(actVal)) {
      collect(expVal, actVal, path, out);
      continue;
    }
    if (isPlainObject(expVal) !== isPlainObject(actVal) || !valuesEqual(expVal, actVal)) {
      out.push({ path, category: 'mismatch', expected: expVal, actual: actVal, reason: 'value differs from effective config' });
    }
  }
  for (const [key, actVal] of Object.entries(actual)) {
    if (key in expected) continue;
    const path = prefix === '' ? key : prefix + '.' + key;
    if (isPlainObject(actVal)) {
      // report each extra leaf so paths stay precise
      const leaves: DriftItem[] = [];
      collectExtras(actVal, path, leaves);
      out.push(...leaves);
    } else {
      out.push({ path, category: 'extra', actual: actVal, reason: 'key present only in snapshot' });
    }
  }
}

function collectExtras(obj: JsonObject, prefix: string, out: DriftItem[]): void {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    out.push({ path: prefix, category: 'extra', actual: {}, reason: 'key present only in snapshot' });
    return;
  }
  for (const [key, val] of entries) {
    const path = prefix + '.' + key;
    if (isPlainObject(val)) collectExtras(val, path, out);
    else out.push({ path, category: 'extra', actual: val, reason: 'key present only in snapshot' });
  }
}

export function compareDrift(effective: JsonObject, snapshot: JsonObject): DriftReport {
  const items: DriftItem[] = [];
  collect(effective, snapshot, '', items);
  items.sort((a, b) => {
    const rank = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
    if (rank !== 0) return rank;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const counts: Record<DriftCategory, number> = { missing: 0, mismatch: 0, extra: 0 };
  for (const item of items) counts[item.category] += 1;
  return { status: items.length === 0 ? 'pass' : 'drifted', counts, items };
}
