/**
 * State adapter: owns all persistence. The kernel speaks in TokenRecord
 * values and atomic transition operations; SQL lives only here.
 *
 * Concurrency contract: rotateIfActive / revokeIfActive are conditional
 * UPDATEs executed inside an IMMEDIATE transaction, so exactly one of
 * several competing transitions can win; losers observe 0 changed rows.
 */
import { DatabaseSync } from 'node:sqlite';
import { computationFailure } from './errors.ts';

export type TokenStatus = 'active' | 'revoked' | 'rotated';

export interface TokenRecord {
  jti: string;
  subject: string;
  scopes: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  status: TokenStatus;
  /** jti of the token that replaced this one, when status = rotated. */
  replacedBy: string | null;
}

interface Row {
  jti: string;
  subject: string;
  scopes: string;
  issued_at: number;
  expires_at: number;
  status: string;
  replaced_by: string | null;
}

const toRecord = (row: Row): TokenRecord => ({
  jti: row.jti,
  subject: row.subject,
  scopes: JSON.parse(row.scopes) as string[],
  issuedAtMs: row.issued_at,
  expiresAtMs: row.expires_at,
  status: row.status as TokenStatus,
  replacedBy: row.replaced_by,
});

export class TokenStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS tokens (' +
          'jti TEXT PRIMARY KEY, ' +
          'subject TEXT NOT NULL, ' +
          'scopes TEXT NOT NULL, ' +
          'issued_at INTEGER NOT NULL, ' +
          'expires_at INTEGER NOT NULL, ' +
          "status TEXT NOT NULL CHECK (status IN ('active','revoked','rotated')), " +
          'replaced_by TEXT' +
          ')',
      );
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tokens_subject ON tokens(subject, status)');
    } catch (err) {
      throw computationFailure('failed to open token store', { cause: String(err) });
    }
  }

  insert(record: TokenRecord): void {
    try {
      this.db
        .prepare(
          'INSERT INTO tokens (jti, subject, scopes, issued_at, expires_at, status, replaced_by) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.jti,
          record.subject,
          JSON.stringify(record.scopes),
          record.issuedAtMs,
          record.expiresAtMs,
          record.status,
          record.replacedBy,
        );
    } catch (err) {
      throw computationFailure('failed to persist token ' + record.jti, { cause: String(err) });
    }
  }

  get(jti: string): TokenRecord | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE jti = ?').get(jti) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  countActiveBySubject(subject: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tokens WHERE subject = ? AND status = 'active'")
      .get(subject) as { n: number };
    return row.n;
  }

  /**
   * Atomically mark `jti` rotated iff it is still active.
   * Returns true iff this call performed the transition.
   */
  rotateIfActive(jti: string, replacedBy: string): boolean {
    return this.transition(jti, 'rotated', replacedBy);
  }

  /** Atomically mark `jti` revoked iff it is still active. */
  revokeIfActive(jti: string): boolean {
    return this.transition(jti, 'revoked', null);
  }

  private transition(jti: string, to: TokenStatus, replacedBy: string | null): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.db
        .prepare(
          "UPDATE tokens SET status = ?, replaced_by = ? WHERE jti = ? AND status = 'active'",
        )
        .run(to, replacedBy, jti);
      this.db.exec('COMMIT');
      return Number(result.changes) === 1;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore secondary rollback failure
      }
      throw computationFailure('state transition failed for token ' + jti, {
        target: to,
        cause: String(err),
      });
    }
  }

  close(): void {
    this.db.close();
  }
}
