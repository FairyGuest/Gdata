import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, computeError, unavailableError } from "../contract/errors.js";
import { migrate } from "./schema.js";

export interface TransactionHooks {
  /** Called before each BEGIN IMMEDIATE attempt (including retries). */
  readonly onBeginAttempt?: () => void;
  /** Called after a write transaction has acquired the SQLite write lock. */
  readonly afterBegin?: () => void | Promise<void>;
}

export interface EngineOptions {
  readonly dbPath: string;
  readonly sqliteBusyTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly maxConnections?: number;
}

const LOCK_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

function isLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  const code = String(record.code ?? "");
  if (LOCK_CODES.has(code)) return true;
  return code === "ERR_SQLITE_ERROR" && /database is locked|database table is locked/i.test(String(record.message ?? ""));
}

export class SqliteEngine {
  readonly dbPath: string;
  private readonly sqliteBusyTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly pool: DatabaseSync[] = [];
  private readonly waiters: Array<() => void> = [];
  private created = 0;
  private booted = false;
  private closed = false;

  constructor(options: EngineOptions) {
    this.dbPath = options.dbPath;
    this.sqliteBusyTimeoutMs = options.sqliteBusyTimeoutMs ?? 5000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.maxConnections = options.maxConnections ?? 8;
  }

  private openConnection(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(`PRAGMA busy_timeout=${this.sqliteBusyTimeoutMs}`);
    return db;
  }

  boot(): void {
    if (this.booted) return;
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    try {
      const db = this.openConnection();
      migrate(db);
      this.pool.push(db);
      this.created = 1;
      this.booted = true;
    } catch (error) {
      throw this.mapStorageFailure(error, "boot");
    }
  }

  private async acquire(): Promise<DatabaseSync> {
    const pooled = this.pool.pop();
    if (pooled) return pooled;
    if (this.created < this.maxConnections) {
      this.created += 1;
      try {
        return this.openConnection();
      } catch (error) {
        this.created -= 1;
        throw this.mapStorageFailure(error, "open-connection");
      }
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    const queued = this.pool.pop();
    if (!queued) {
      throw unavailableError("storage_unavailable", "connection pool released a slot without a connection");
    }
    return queued;
  }

  private release(db: DatabaseSync): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      this.pool.push(db);
      waiter();
    } else {
      this.pool.push(db);
    }
  }

  async read<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    if (!this.booted) throw unavailableError("storage_unavailable", "storage has not been booted");
    const db = await this.acquire();
    try {
      return await fn(db);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw this.mapStorageFailure(error, "read");
    } finally {
      this.release(db);
    }
  }

  /**
   * Runs fn inside BEGIN IMMEDIATE ... COMMIT. SQLite serializes writers by its
   * single writer lock; the resulting commit order (commit_log.seq) is the sole
   * arbitration source. BUSY is retried until lockTimeoutMs, then surfaced as 503.
   */
  async writeTx<T>(fn: (db: DatabaseSync) => Promise<T> | T, hooks?: TransactionHooks): Promise<T> {
    if (!this.booted) throw unavailableError("storage_unavailable", "storage has not been booted");
    if (this.closed) throw unavailableError("storage_unavailable", "storage is closed");
    const startedAt = this.nowMs();
    let attempt = 0;
    for (;;) {
      const db = await this.acquire();
      let began = false;
      try {
        hooks?.onBeginAttempt?.();
        db.exec("BEGIN IMMEDIATE");
        began = true;
        await hooks?.afterBegin?.();
        const result = await fn(db);
        db.exec("COMMIT");
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // rollback best-effort; original error is the meaningful one
          }
        }
        if (isLockError(error)) {
          attempt += 1;
          const elapsed = this.nowMs() - startedAt;
          if (elapsed >= this.lockTimeoutMs) {
            throw unavailableError("lock_timeout", "timed out waiting for the SQLite writer lock", {
              attempts: attempt,
              waitedMs: Math.round(elapsed),
              timeoutMs: this.lockTimeoutMs,
            });
          }
          await this.delay(Math.min(20, attempt * 2));
          continue;
        }
        if (error instanceof AppError) throw error;
        throw this.mapStorageFailure(error, "write-tx");
      } finally {
        this.release(db);
      }
    }
  }

  private mapStorageFailure(error: unknown, phase: string): AppError {
    if (error instanceof AppError) return error;
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
    if (code === "SQLITE_CANTOPEN" || code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT" || code === "SQLITE_IOERR") {
      return unavailableError("storage_unavailable", "SQLite storage is unavailable", {
        phase,
        sqliteCode: code,
      });
    }
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      return computeError("invariant_violation", "SQLite constraint rejected a ledger state transition", {
        phase,
        sqliteCode: code,
      });
    }
    return computeError("unexpected_error", "unexpected storage failure", {
      phase,
      sqliteCode: code ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private nowMs(): number {
    const hr = process.hrtime.bigint();
    return Number(hr) / 1_000_000;
  }

  close(): void {
    for (const db of this.pool) {
      try {
        db.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.pool.length = 0;
    this.closed = true;
  }
}
