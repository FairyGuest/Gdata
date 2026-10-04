
import { DatabaseSync } from "node:sqlite";

export interface CodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  consumedAt: number | null;
}

export interface TokenRecord {
  token: string;
  clientId: string;
  expiresAt: number;
}

export interface RefreshRecord {
  token: string;
  clientId: string;
  expiresAt: number;
  revokedAt: number | null;
}

export interface Store {
  insertCode(rec: CodeRecord): void;
  consumeCode(code: string, at: number): boolean;
  getCode(code: string): CodeRecord | undefined;
  insertAccessToken(rec: TokenRecord): void;
  getAccessToken(token: string): TokenRecord | undefined;
  insertRefreshToken(rec: RefreshRecord): void;
  getRefreshToken(token: string): RefreshRecord | undefined;
  rotateRefreshToken(oldToken: string, next: RefreshRecord, at: number): boolean;
  close(): void;
}

/** SQLite state adapter backed by Node's built-in node:sqlite. */
export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS codes (" +
        "code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL," +
        "code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);" +
        "CREATE TABLE IF NOT EXISTS access_tokens (" +
        "token TEXT PRIMARY KEY, client_id TEXT NOT NULL, expires_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS refresh_tokens (" +
        "token TEXT PRIMARY KEY, client_id TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);",
    );
  }

  insertCode(rec: CodeRecord): void {
    this.db
      .prepare(
        "INSERT INTO codes (code, client_id, redirect_uri, code_challenge, expires_at, consumed_at) VALUES (?,?,?,?,?,NULL)",
      )
      .run(rec.code, rec.clientId, rec.redirectUri, rec.codeChallenge, rec.expiresAt);
  }

  consumeCode(code: string, at: number): boolean {
    const r = this.db
      .prepare("UPDATE codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL")
      .run(at, code);
    return Number(r.changes) === 1;
  }

  getCode(code: string): CodeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM codes WHERE code = ?").get(code) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      code: row.code as string,
      clientId: row.client_id as string,
      redirectUri: row.redirect_uri as string,
      codeChallenge: row.code_challenge as string,
      expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    };
  }

  insertAccessToken(rec: TokenRecord): void {
    this.db
      .prepare("INSERT INTO access_tokens (token, client_id, expires_at) VALUES (?,?,?)")
      .run(rec.token, rec.clientId, rec.expiresAt);
  }

  getAccessToken(token: string): TokenRecord | undefined {
    const row = this.db.prepare("SELECT * FROM access_tokens WHERE token = ?").get(token) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      token: row.token as string,
      clientId: row.client_id as string,
      expiresAt: Number(row.expires_at),
    };
  }

  insertRefreshToken(rec: RefreshRecord): void {
    this.db
      .prepare(
        "INSERT INTO refresh_tokens (token, client_id, expires_at, revoked_at) VALUES (?,?,?,NULL)",
      )
      .run(rec.token, rec.clientId, rec.expiresAt);
  }

  getRefreshToken(token: string): RefreshRecord | undefined {
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token = ?").get(token) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      token: row.token as string,
      clientId: row.client_id as string,
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  }

  rotateRefreshToken(oldToken: string, next: RefreshRecord, at: number): boolean {
    // Single conditional UPDATE is atomic in SQLite: exactly one caller
    // can flip revoked_at from NULL, so concurrent rotation has one winner.
    const r = this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL")
      .run(at, oldToken);
    if (Number(r.changes) !== 1) return false;
    this.insertRefreshToken(next);
    return true;
  }

  close(): void {
    this.db.close();
  }
}
