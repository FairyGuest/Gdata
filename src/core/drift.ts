// Drift kernel: structural comparison between the effective config and a
// runtime snapshot. Differences are located by dot-path and classified:
//
//   missing_required   key required by effective config, absent in snapshot (heaviest)
//   value_mismatch     key present on both sides, values differ
//   extra_in_snapshot  key present only in the runtime snapshot (lightest)
//
// Entries are ordered by severity (desc), then path (asc, lexicographic).
// No differences yields an explicit PASS marker.

import { DRIFT_SEVERITY } from "../contracts/types.ts";
import type { DriftEntry, DriftKind, DriftReport, JsonObject, JsonValue } from "../contracts/types.ts";
import { isPlainObject } from "./merge.ts";

function valuesEqual(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => valuesEqual(item, b[i]!));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && valuesEqual(a[k]!, b[k]!));
  }
  return a === b;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function collect(expected: JsonValue, actual: JsonValue, path: string, out: DriftEntry[]): void {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    for (const key of Object.keys(expected)) {
      const p = join(path, key);
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        out.push({ path: p, kind: "missing_required", expected: expected[key]!, reason: `required key "${p}" is absent from the runtime snapshot` });
      } else {
        collect(expected[key]!, actual[key]!, p, out);
      }
    }
    for (const key of Object.keys(actual)) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        const p = join(path, key);
        out.push({ path: p, kind: "extra_in_snapshot", actual: actual[key]!, reason: `snapshot key "${p}" has no counterpart in the effective config` });
      }
    }
    return;
  }
  if (!valuesEqual(expected, actual)) {
    out.push({ path, kind: "value_mismatch", expected, actual, reason: `value at "${path}" differs: expected ${JSON.stringify(expected)}, snapshot has ${JSON.stringify(actual)}` });
  }
}

export function diffConfigs(effective: JsonObject, snapshot: JsonValue, env: string): DriftReport {
  const drifts: DriftEntry[] = [];
  if (!isPlainObject(snapshot)) {
    drifts.push({
      path: "",
      kind: "value_mismatch",
      expected: effective,
      actual: snapshot,
      reason: "runtime snapshot is not a JSON object",
    });
  } else {
    collect(effective, snapshot, "", drifts);
  }
  drifts.sort((a, b) => {
    const sev = DRIFT_SEVERITY[b.kind] - DRIFT_SEVERITY[a.kind];
    if (sev !== 0) return sev;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const counts: Record<DriftKind, number> = { missing_required: 0, value_mismatch: 0, extra_in_snapshot: 0 };
  for (const d of drifts) counts[d.kind] += 1;
  return { status: drifts.length === 0 ? "PASS" : "DRIFT", env, drifts, counts };
}
