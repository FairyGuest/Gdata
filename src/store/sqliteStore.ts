/** 状态适配层：SQLite(node:sqlite) 持久化。三层扣减在单个事务内原子完成。 */
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain/errors.ts';
import type { ApiKey, LevelBalance, Scope, ScopeLevel, UsageEvent } from '../domain/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('global','org','project')),
  parent_id TEXT,
  quota_limit INTEGER NOT NULL CHECK (quota_limit >= 0),
  quota_used INTEGER NOT NULL DEFAULT 0 CHECK (quota_used >= 0)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL UNIQUE,
  project_scope_id TEXT NOT NULL REFERENCES scopes(id),
  status TEXT NOT NULL CHECK (status IN ('active','grace','expired')),
  created_at INTEGER NOT NULL,
  grace_until INTEGER,
  rotated_to TEXT
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL,
  request_id TEXT
);
`;

interface ScopeRow { id: string; level: string; parent_id: string | null; quota_limit: number; quota_used: number }
interface KeyRow { id: string; secret: string; project_scope_id: string; status: string; created_at: number; grace_until: number | null; rotated_to: string | null }
interface UsageRow { id: number; key_id: string; amount: number; at: number; request_id: string | null }

function toScope(r: ScopeRow): Scope {
  return { id: r.id, level: r.level as ScopeLevel, parentId: r.parent_id, quotaLimit: r.quota_limit, quotaUsed: r.quota_used };
}
function toKey(r: KeyRow): ApiKey {
  return { id: r.id, secret: r.secret, projectScopeId: r.project_scope_id, status: r.status as ApiKey['status'], createdAt: r.created_at, graceUntil: r.grace_until, rotatedTo: r.rotated_to };
}
function toUsage(r: UsageRow): UsageEvent {
  return { id: r.id, keyId: r.key_id, amount: r.amount, at: r.at, requestId: r.request_id };
}

export interface ConsumeTxResult {
  balances: LevelBalance[];
}

export class SqliteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createScope(scope: { id: string; level: ScopeLevel; parentId: string | null; quotaLimit: number }): Scope {
    try {
      this.db.prepare('INSERT INTO scopes (id, level, parent_id, quota_limit, quota_used) VALUES (?, ?, ?, ?, 0)')
        .run(scope.id, scope.level, scope.parentId, scope.quotaLimit);
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new AppError('CONFLICT', `scope already exists: ${scope.id}`, { scopeId: scope.id });
      }
      throw err;
    }
    return this.getScope(scope.id)!;
  }

  getScope(id: string): Scope | null {
    const row = this.db.prepare('SELECT * FROM scopes WHERE id = ?').get(id) as ScopeRow | undefined;
    return row ? toScope(row) : null;
  }

  listScopes(): Scope[] {
    const rows = this.db.prepare('SELECT * FROM scopes ORDER BY id').all() as unknown as ScopeRow[];
    return rows.map(toScope);
  }

  insertKey(key: ApiKey): void {
    try {
      this.db.prepare('INSERT INTO api_keys (id, secret, project_scope_id, status, created_at, grace_until, rotated_to) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(key.id, key.secret, key.projectScopeId, key.status, key.createdAt, key.graceUntil, key.rotatedTo);
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new AppError('CONFLICT', `key id or secret already exists: ${key.id}`, { keyId: key.id });
      }
      throw err;
    }
  }

  findKeyBySecret(secret: string): ApiKey | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE secret = ?').get(secret) as KeyRow | undefined;
    return row ? toKey(row) : null;
  }

  getKey(id: string): ApiKey | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as KeyRow | undefined;
    return row ? toKey(row) : null;
  }

  markKeyGrace(keyId: string, graceUntil: number, rotatedTo: string): void {
    this.db.prepare("UPDATE api_keys SET status = 'grace', grace_until = ?, rotated_to = ? WHERE id = ?")
      .run(graceUntil, rotatedTo, keyId);
  }

  markKeyExpired(keyId: string): void {
    this.db.prepare("UPDATE api_keys SET status = 'expired' WHERE id = ?").run(keyId);
  }

  /**
   * 原子三层扣减：BEGIN IMMEDIATE 内对 project -> org -> global 逐层做
   * 带守卫条件的 UPDATE（quota_used + amount <= quota_limit），任一层
   * 不满足即 ROLLBACK，抛 QUOTA_EXCEEDED；全部满足则写 usage_events 并 COMMIT。
   * 守卫条件在 SQL 内求值，并发下不会丢失更新也不会超扣。
   */
  consumeAtomic(chain: Scope[], keyId: string, amount: number, at: number, requestId: string | null): ConsumeTxResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const balances: LevelBalance[] = [];
      const update = this.db.prepare(
        'UPDATE scopes SET quota_used = quota_used + ? WHERE id = ? AND quota_used + ? <= quota_limit',
      );
      const read = this.db.prepare('SELECT * FROM scopes WHERE id = ?');
      for (const scope of chain) {
        const res = update.run(amount, scope.id, amount);
        if (Number(res.changes) !== 1) {
          const cur = read.get(scope.id) as unknown as ScopeRow;
          throw new AppError('QUOTA_EXCEEDED', `quota exceeded at ${scope.level} scope ${scope.id}`, {
            level: scope.level,
            scopeId: scope.id,
            limit: cur.quota_limit,
            used: cur.quota_used,
            remaining: cur.quota_limit - cur.quota_used,
            requested: amount,
          });
        }
        const cur = read.get(scope.id) as unknown as ScopeRow;
        balances.push({ level: cur.level as ScopeLevel, scopeId: cur.id, limit: cur.quota_limit, used: cur.quota_used, remaining: cur.quota_limit - cur.quota_used });
      }
      this.db.prepare('INSERT INTO usage_events (key_id, amount, at, request_id) VALUES (?, ?, ?, ?)')
        .run(keyId, amount, at, requestId);
      this.db.exec('COMMIT');
      return { balances };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 返回 project -> org -> global 的作用域链（含快照）。 */
  scopeChain(projectScopeId: string): Scope[] {
    const chain: Scope[] = [];
    let cur = this.getScope(projectScopeId);
    if (!cur) throw new AppError('NOT_FOUND', `project scope not found: ${projectScopeId}`, { scopeId: projectScopeId });
    if (cur.level !== 'project') throw new AppError('INVALID_REQUEST', `scope ${projectScopeId} is not a project scope`, { scopeId: projectScopeId });
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? this.getScope(cur.parentId) : null;
    }
    return chain;
  }


  listKeys(): ApiKey[] {
    const rows = this.db.prepare('SELECT * FROM api_keys ORDER BY created_at, id').all() as unknown as KeyRow[];
    return rows.map(toKey);
  }

  usageEventsForKey(keyId: string): UsageEvent[] {
    const rows = this.db.prepare('SELECT * FROM usage_events WHERE key_id = ? ORDER BY id').all(keyId) as unknown as UsageRow[];
    return rows.map(toUsage);
  }

  totalConsumedForKey(keyId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE key_id = ?').get(keyId) as { total: number };
    return row.total;
  }
}

