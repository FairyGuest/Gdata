// Minimal ambient declarations for offline environments without @types/node.
// The runtime is Node >= 22.6 (native TS type stripping + node:sqlite).
declare module 'node:crypto' { export function createHash(algo: string): { update(data: unknown): any; digest(enc: string): string }; }
declare module 'node:fs' {
  export function readFileSync(path: string, enc?: string): any;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
}
declare module 'node:os' { export function tmpdir(): string; }
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
}
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
    close(): void;
  }
}
declare module 'node:test' {
  export function test(name: string, fn: (t: { after(fn: () => void): void }) => unknown): void;
}
declare module 'node:assert/strict' {
  const assert: {
    equal(a: unknown, b: unknown, msg?: string): void;
    deepEqual(a: unknown, b: unknown, msg?: string): void;
    match(s: string, re: RegExp, msg?: string): void;
    throws(fn: () => unknown, check?: (err: unknown) => boolean): void;
  };
  export default assert;
}
declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(sig: string, fn: () => void): void;
};