// Local ambient shims: the offline environment cannot fetch @types/node.
// Only the surfaces actually used by this project are declared.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  const assert: {
    equal(a: unknown, b: unknown, msg?: string): void;
    deepEqual(a: unknown, b: unknown, msg?: string): void;
    ok(v: unknown, msg?: string): void;
    throws(fn: () => void, check?: (err: unknown) => boolean, msg?: string): void;
    notEqual(a: unknown, b: unknown, msg?: string): void;
  };
  export = assert;
}
declare module "node:crypto" {
  export function randomUUID(): string;
}
declare module "node:fs" {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
}
declare module "node:path" {
  export function dirname(p: string): string;
}
declare var process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  argv: string[];
  cwd(): string;
};
declare var console: { log(...a: unknown[]): void; error(...a: unknown[]): void };

declare module "node:fs" {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, opts?: { force?: boolean; recursive?: boolean }): void;
}
declare function fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;
