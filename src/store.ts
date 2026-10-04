import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AuthCodeRecord, TokenRecord } from "./contracts.ts";
import { Errors } from "./errors.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  family_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_family ON tokens(family_id);
`;

export class StateStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  countActiveCodes(clientId: string, now: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM auth_codes WHERE client_id = ? AND consumed_at IS NULL AND expires_at > ?")
      .get(clientId, now) as { n: number };
    return row.n;
  }

  insertCode(rec: AuthCodeRecord): void {
    this.db
      .prepare(
        "INSERT INTO auth_codes (code, client_id, redirect_uri, code_challenge, scope, issued_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
      )
      .run(rec.code, rec.clientId, rec.redirectUri, rec.codeChallenge, rec.scope, rec.issuedAt, rec.expiresAt);
  }

  getCode(code: string): AuthCodeRecord | null {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code = ?").get(code) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      code: row.code as string,
      clientId: row.client_id as string,
      redirectUri: row.redirect_uri as string,
      codeChallenge: row.code_challenge as string,
      scope: row.scope as string,
      issuedAt: row.issued_at as number,
      expiresAt: row.expires_at as number,
      consumedAt: (row.consumed_at as number | null) ?? null,
    };
  }

  consumeCode(code: string, now: number): boolean {
    const res = this.db
      .prepare("UPDATE auth_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL")
      .run(now, code);
    return res.changes === 1;
  }

  insertToken(rec: TokenRecord): void {
    this.db
      .prepare(
        "INSERT INTO tokens (token, kind, client_id, scope, issued_at, expires_at, consumed_at, family_id) VALUES (?,?,?,?,?,?,NULL,?)",
      )
      .run(rec.token, rec.kind, rec.clientId, rec.scope, rec.issuedAt, rec.expiresAt, rec.familyId);
  }

  getToken(token: string): TokenRecord | null {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token = ?").get(token) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      token: row.token as string,
      kind: row.kind as "access" | "refresh",
      clientId: row.client_id as string,
      scope: row.scope as string,
      issuedAt: row.issued_at as number,
      expiresAt: row.expires_at as number,
      consumedAt: (row.consumed_at as number | null) ?? null,
      familyId: row.family_id as string,
    };
  }

  consumeRefreshToken(token: string, now: number): boolean {
    const res = this.db
      .prepare("UPDATE tokens SET consumed_at = ? WHERE token = ? AND kind = 'refresh' AND consumed_at IS NULL")
      .run(now, token);
    return res.changes === 1;
  }

  revokeFamily(familyId: string, now: number): number {
    const res = this.db
      .prepare("UPDATE tokens SET consumed_at = ? WHERE family_id = ? AND consumed_at IS NULL")
      .run(now, familyId);
    return Number(res.changes);
  }

  stats(now: number) {
    const q = (sql: string, ...args: (string | number)[]) =>
      (this.db.prepare(sql).get(...args) as { n: number }).n;
    return {
      codesActive: q("SELECT COUNT(*) AS n FROM auth_codes WHERE consumed_at IS NULL AND expires_at > ?", now),
      codesConsumed: q("SELECT COUNT(*) AS n FROM auth_codes WHERE consumed_at IS NOT NULL"),
      codesExpired: q("SELECT COUNT(*) AS n FROM auth_codes WHERE consumed_at IS NULL AND expires_at <= ?", now),
      accessActive: q("SELECT COUNT(*) AS n FROM tokens WHERE kind='access' AND consumed_at IS NULL AND expires_at > ?", now),
      refreshActive: q("SELECT COUNT(*) AS n FROM tokens WHERE kind='refresh' AND consumed_at IS NULL AND expires_at > ?", now),
      refreshConsumed: q("SELECT COUNT(*) AS n FROM tokens WHERE kind='refresh' AND consumed_at IS NOT NULL"),
    };
  }
}

export function newTokenValue(prefix: string): string {
  return prefix + "_" + randomUUID().replaceAll("-", "");
}
