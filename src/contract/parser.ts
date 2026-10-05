import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inputError } from "./errors.ts";
import type { DiscoveredFile } from "./types.ts";

/**
 * Convert a glob-ish pattern (supporting * and **) to a RegExp matched
 * against POSIX-style relative paths.
 */
export function patternToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*" && pattern.charAt(i + 2) === "/") {
      out += "(?:.*/)?";
      i += 3;
    } else if (c === "*" && pattern.charAt(i + 1) === "*") {
      out += ".*";
      i += 2;
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if ("\\.+^$?()|[]{}".indexOf(c) !== -1) {
      out += "\\" + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp("^" + out + "$");
}

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      await walk(abs, base, out);
    } else {
      out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
  }
}

/** Shape a test file's module must satisfy. */
export interface TestFileModule {
  tests: Record<string, () => unknown | Promise<unknown>>;
  dependsOn?: string[];
}

/** Import a test file and validate its contract. Throws INPUT_ERROR on violation. */
export async function loadTestFileModule(absPath: string): Promise<TestFileModule> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(absPath).href);
  } catch (err) {
    throw inputError(
      "failed to load test file " + absPath + ": " + (err instanceof Error ? err.message : String(err)),
    );
  }
  const m = mod as Partial<TestFileModule>;
  if (m.tests === undefined || m.tests === null || typeof m.tests !== "object") {
    throw inputError("test file " + absPath + " must export a 'tests' object");
  }
  for (const [name, fn] of Object.entries(m.tests)) {
    if (typeof fn !== "function") {
      throw inputError("test case '" + name + "' in " + absPath + " is not a function");
    }
  }
  if (m.dependsOn !== undefined && !Array.isArray(m.dependsOn)) {
    throw inputError("'dependsOn' in " + absPath + " must be an array of file paths");
  }
  return m as TestFileModule;
}

/**
 * Discover test files under dir matching pattern, and parse each file's
 * contract (exported case names + dependencies).
 */
export async function discoverTests(dir: string, pattern: string): Promise<DiscoveredFile[]> {
  const absDir = path.resolve(dir);
  const stat = await fs.stat(absDir).catch(() => null);
  if (!stat) throw inputError("directory does not exist: " + absDir);
  if (!stat.isDirectory()) throw inputError("not a directory: " + absDir);

  const regex = patternToRegex(pattern);

  const all: string[] = [];
  await walk(absDir, absDir, all);
  const matched = all.filter((rel) => regex.test(rel)).sort();

  const files: DiscoveredFile[] = [];
  for (const rel of matched) {
    const absPath = path.join(absDir, rel);
    const mod = await loadTestFileModule(absPath);
    files.push({
      absPath,
      relPath: rel,
      cases: Object.keys(mod.tests),
      dependsOn: mod.dependsOn ?? [],
    });
  }

  // Validate dependency references and detect cycles.
  const known = new Set(files.map((f) => f.relPath));
  for (const f of files) {
    for (const dep of f.dependsOn) {
      if (!known.has(dep)) {
        throw inputError("file " + f.relPath + " depends on unknown file " + dep);
      }
    }
  }
  const state = new Map<string, number>(); // 0=unvisited 1=in-stack 2=done
  const visit = (rel: string, stack: string[]): void => {
    const s = state.get(rel) ?? 0;
    if (s === 2) return;
    if (s === 1) throw inputError("dependency cycle detected: " + [...stack, rel].join(" -> "));
    state.set(rel, 1);
    const file = files.find((f) => f.relPath === rel);
    for (const dep of file?.dependsOn ?? []) visit(dep, [...stack, rel]);
    state.set(rel, 2);
  };
  for (const f of files) visit(f.relPath, []);

  return files;
}

