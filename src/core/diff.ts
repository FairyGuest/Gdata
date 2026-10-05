import type { FieldDiff, JsonValue } from "../contract/types.ts";

// Pure structured diff engine. No I/O, no framework dependencies.
// Paths: object keys joined with ".", array indices as "[i]".
// Arrays are compared element-wise by index; extra elements on either
// side are reported as added/removed at their index path.

const isPlainObject = (v: JsonValue): v is { [key: string]: JsonValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const joinKey = (base: string, key: string): string => (base === "" ? key : base + "." + key);
const joinIndex = (base: string, i: number): string => base + "[" + i + "]";

function diffValue(path: string, before: JsonValue, after: JsonValue, out: FieldDiff[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    diffObject(path, before, after, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(path, before, after, out);
    return;
  }
  if (!Object.is(before, after)) {
    out.push({ path, type: "modified", before, after });
  }
}

function diffObject(
  path: string,
  before: { [key: string]: JsonValue },
  after: { [key: string]: JsonValue },
  out: FieldDiff[],
): void {
  for (const key of Object.keys(before)) {
    const p = joinKey(path, key);
    if (!(key in after)) {
      out.push({ path: p, type: "removed", before: before[key] });
    } else {
      diffValue(p, before[key], after[key], out);
    }
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      out.push({ path: joinKey(path, key), type: "added", after: after[key] });
    }
  }
}

function diffArray(path: string, before: JsonValue[], after: JsonValue[], out: FieldDiff[]): void {
  const common = Math.min(before.length, after.length);
  for (let i = 0; i < common; i++) {
    diffValue(joinIndex(path, i), before[i], after[i], out);
  }
  for (let i = common; i < before.length; i++) {
    out.push({ path: joinIndex(path, i), type: "removed", before: before[i] });
  }
  for (let i = common; i < after.length; i++) {
    out.push({ path: joinIndex(path, i), type: "added", after: after[i] });
  }
}

// Normalize a user-supplied ignore path into canonical segments.
// Accepts "a.b[0].c" and "a.b.0.c" forms; returns canonical "a.b[0].c".
export function normalizePath(path: string): string {
  const segments: string[] = [];
  let cur = "";
  for (const ch of path) {
    if (ch === ".") {
      if (cur !== "") segments.push(cur);
      cur = "";
    } else if (ch === "[") {
      if (cur !== "") segments.push(cur);
      cur = "[";
    } else if (ch === "]") {
      if (cur !== "") segments.push(cur + "]");
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") segments.push(cur);
  return segments
    .map((s) => (/^\d+$/.test(s) ? "[" + s + "]" : s))
    .reduce((acc, s) => (s.startsWith("[") ? acc + s : acc === "" ? s : acc + "." + s), "");
}

// Structured diff with ignored paths. A diff entry is dropped when its path
// equals an ignored path or lies beneath one (e.g. ignoring "meta" also
// ignores "meta.ts"). Ignoring "items[1]" ignores only that element subtree.
export function structuredDiff(
  before: JsonValue,
  after: JsonValue,
  ignorePaths: string[] = [],
): FieldDiff[] {
  const ignored = ignorePaths.map(normalizePath);
  const raw: FieldDiff[] = [];
  diffValue("", before, after, raw);
  return raw.filter((d) => {
    const p = normalizePath(d.path);
    return !ignored.some((ig) => p === ig || p.startsWith(ig + ".") || p.startsWith(ig + "["));
  });
}
