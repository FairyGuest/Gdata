// Wildcard matcher: '*' matches exactly one path segment, '**' matches any
// number of remaining segments (including zero). Segments are split on '/'.
export function matchPattern(pattern: string, value: string): boolean {
  const p = pattern.split("/");
  const v = value.split("/");
  return matchSegs(p, v);
}

function matchSegs(p: string[], v: string[]): boolean {
  if (p.length === 0) return v.length === 0;
  const [head, ...rest] = p;
  if (head === "**") {
    for (let i = 0; i <= v.length; i++) {
      if (matchSegs(rest, v.slice(i))) return true;
    }
    return false;
  }
  if (v.length === 0) return false;
  if (head !== "*" && head !== v[0]) return false;
  return matchSegs(rest, v.slice(1));
}

