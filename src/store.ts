import { DatabaseSync } from "node:sqlite";

export type TokenStatus = "active" | "rotated" | "revoked";

export interface TokenRow {
  jti: string;
  sub: string;
  scopes: string;
  iat: number;
  exp: number;
  status: TokenStatus;
  replaced_by: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  jti TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  scopes TEXT NOT NULL,
  iat INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','rotated','revoked')),
  replaced_by TEXT
);`;

export class TokenStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  insert(row: TokenRow): void {
    this.db
      .prepare(
        "INSERT INTO tokens (jti, sub, scopes, iat, exp, status, replaced_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(row.jti, row.sub, row.scopes, row.iat, row.exp, row.status, row.replaced_by);
  }

  get(jti: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM tokens WHERE jti = ?").get(jti) as
      | TokenRow
      | undefined;
  }

  revoke(jti: string): boolean {
    const r = this.db
      .prepare("UPDATE tokens SET status = 'revoked' WHERE jti = ? AND status = 'active'")
      .run(jti);
    return Number(r.changes) === 1;
  }

  // Atomic compare-and-set: exactly one concurrent caller wins the rotation.
  rotate(jti: string, newJti: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE tokens SET status = 'rotated', replaced_by = ? WHERE jti = ? AND status = 'active'"
      )
      .run(newJti, jti);
    return Number(r.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}