// Minimal adapter over Node's built-in synchronous SQLite (node:sqlite, Node >= 22.5/24).
// Exposes only the surface used by this service: exec/prepare/run(all/get) and
// manual IMMEDIATE transactions. Timing-sensitive concurrency is decided by
// SQL-level locks plus our own commit_seq, never by wall clocks.
import { DatabaseSync, StatementSync } from 'node:sqlite';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export class SqliteDb {
  readonly inner: DatabaseSync;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  pragma(sql: string): void {
    this.inner.exec(`PRAGMA ${sql}`);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const stmt: StatementSync = this.inner.prepare(sql);
    return {
      get: (...params: unknown[]) => stmt.get(...params as never[]) as unknown,
      all: (...params: unknown[]) => stmt.all(...params as never[]) as unknown[],
      run: (...params: unknown[]) => {
        const r = stmt.run(...params as never[]);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
    };
  }

  beginImmediate(): void {
    this.inner.exec('BEGIN IMMEDIATE');
  }

  commit(): void {
    this.inner.exec('COMMIT');
  }

  rollback(): void {
    this.inner.exec('ROLLBACK');
  }

  close(): void {
    this.inner.close();
  }
}

export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === 'SQLITE_BUSY' || code === 'ERR_SQLITE_ERROR' && String((err as Error).message).includes('busy');
}

