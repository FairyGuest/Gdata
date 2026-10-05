// Path matching for ignored fields.
// Path syntax: dot-separated object keys, [n] for array indices, "*" matches one segment.
// Examples: "meta.timestamp", "items[*].updatedAt", "items[0].id"

export function parsePath(pattern: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === ".") {
      if (current) segments.push(current);
      current = "";
    } else if (ch === "[") {
      if (current) segments.push(current);
      current = "";
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        current = pattern.slice(i);
        break;
      }
      segments.push("[" + pattern.slice(i + 1, close) + "]");
      i = close;
    } else {
      current += ch;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function matchesPath(pattern: string, path: string): boolean {
  const p = parsePath(pattern);
  const s = parsePath(path);
  if (p.length !== s.length) return false;
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    if (seg === "*" || seg === "[*]") continue;
    if (p[i] !== s[i]) return false;
  }
  return true;
}

export function isIgnored(ignorePatterns: string[], path: string): boolean {
  for (const pattern of ignorePatterns) {
    if (matchesPath(pattern, path)) return true;
  }
  return false;
}
