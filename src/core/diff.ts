import type { DiffEntry, JsonValue } from "../contract/types.ts";

export interface DiffOutcome {
  entries: DiffEntry[];
  truncated: boolean;
}

function isPlainObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function childPath(base: string, key: string): string {
  return base === "" ? key : base + "." + key;
}

function indexPath(base: string, index: number): string {
  return base + "[" + index + "]";
}

export function diffValues(
  before: JsonValue,
  after: JsonValue,
  maxEntries: number,
  basePath = "",
  out: DiffEntry[] = [],
): DiffOutcome {
  if (out.length >= maxEntries) return { entries: out, truncated: true };

  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let i = 0; i < shared; i++) {
      diffValues(before[i] as JsonValue, after[i] as JsonValue, maxEntries, indexPath(basePath, i), out);
      if (out.length >= maxEntries) return { entries: out, truncated: true };
    }
    for (let i = shared; i < before.length; i++) {
      out.push({ path: indexPath(basePath, i), kind: "removed", before: before[i] as JsonValue });
      if (out.length >= maxEntries) return { entries: out, truncated: true };
    }
    for (let i = shared; i < after.length; i++) {
      out.push({ path: indexPath(basePath, i), kind: "added", after: after[i] as JsonValue });
      if (out.length >= maxEntries) return { entries: out, truncated: true };
    }
    return { entries: out, truncated: false };
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      const path = childPath(basePath, key);
      if (!(key in after)) {
        out.push({ path, kind: "removed", before: before[key] as JsonValue });
      } else {
        diffValues(before[key] as JsonValue, after[key] as JsonValue, maxEntries, path, out);
      }
      if (out.length >= maxEntries) return { entries: out, truncated: true };
    }
    for (const key of Object.keys(after)) {
      if (!(key in before)) {
        out.push({ path: childPath(basePath, key), kind: "added", after: after[key] as JsonValue });
        if (out.length >= maxEntries) return { entries: out, truncated: true };
      }
    }
    return { entries: out, truncated: false };
  }

  if (before === after) return { entries: out, truncated: false };
  // numeric edge: NaN/Infinity already rejected at validation; treat -0 === 0 as equal
  if (typeof before === "number" && typeof after === "number" && before === after) {
    return { entries: out, truncated: false };
  }
  out.push({ path: basePath === "" ? "$" : basePath, kind: "changed", before, after });
  return { entries: out, truncated: out.length >= maxEntries };
}
