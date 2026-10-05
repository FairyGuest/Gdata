// 状态适配层：SQLite 持久化请求记录与每条规则的命中计数。
// 对内暴露同步方法；reset 清空记录与计数。默认内存库，可指定文件路径。

import { DatabaseSync } from 'node:sqlite';
import type { RecordedRequest, MockStats } from '../contracts/types.js';
import { resourceExhausted, executionFailure } from '../contracts/errors.js';

export const MAX_RECORDS = 100_000;

export class MockStore {
  private db: DatabaseSync;

  constructor(dbPath = ':memory:', private maxRecords = MAX_RECORDS) {
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          query TEXT NOT NULL,
          headers TEXT NOT NULL,
          body TEXT,
          matched_rule_id TEXT,
          responded_status INTEGER,
          received_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rule_hits (
          rule_id TEXT PRIMARY KEY,
          hits INTEGER NOT NULL DEFAULT 0
        );
      `);
    } catch (e) {
      throw executionFailure('SQLite 初始化失败', String(e));
    }
  }

  /** 记录一条请求，返回全局序号。 */
  record(req: Omit<RecordedRequest, 'seq'>): number {
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number };
    if (count.c >= this.maxRecords) throw resourceExhausted(`请求记录数超过上限 ${this.maxRecords}`);
    const r = this.db.prepare(
      'INSERT INTO requests (method, path, query, headers, body, matched_rule_id, responded_status, received_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      req.method, req.path, JSON.stringify(req.query), JSON.stringify(req.headers),
      req.body === undefined ? null : JSON.stringify(req.body),
      req.matchedRuleId, req.respondedStatus, req.receivedAt
    );
    return Number(r.lastInsertRowid);
  }

  /** 递增规则命中计数并返回新值（即本次调用序号）。 */
  nextHit(ruleId: string): number {
    this.db.prepare('INSERT INTO rule_hits (rule_id, hits) VALUES (?, 0) ON CONFLICT(rule_id) DO NOTHING').run(ruleId);
    this.db.prepare('UPDATE rule_hits SET hits = hits + 1 WHERE rule_id = ?').run(ruleId);
    const row = this.db.prepare('SELECT hits FROM rule_hits WHERE rule_id = ?').get(ruleId) as { hits: number };
    return row.hits;
  }

  hitsOf(ruleId: string): number {
    const row = this.db.prepare('SELECT hits FROM rule_hits WHERE rule_id = ?').get(ruleId) as { hits: number } | undefined;
    return row?.hits ?? 0;
  }

  listRequests(): RecordedRequest[] {
    const rows = this.db.prepare('SELECT * FROM requests ORDER BY seq ASC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      method: r.method as string,
      path: r.path as string,
      query: JSON.parse(r.query as string),
      headers: JSON.parse(r.headers as string),
      body: r.body === null ? undefined : JSON.parse(r.body as string),
      matchedRuleId: (r.matched_rule_id as string) ?? null,
      respondedStatus: (r.responded_status as number) ?? null,
      receivedAt: r.received_at as string,
    }));
  }

  stats(): MockStats {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM requests').get() as { c: number }).c;
    const unmatched = (this.db.prepare('SELECT COUNT(*) AS c FROM requests WHERE matched_rule_id IS NULL').get() as { c: number }).c;
    const rules = (this.db.prepare('SELECT rule_id, hits FROM rule_hits ORDER BY rule_id').all() as Array<{ rule_id: string; hits: number }>)
      .map((r) => ({ ruleId: r.rule_id, hits: r.hits }));
    return { totalRequests: total, unmatchedRequests: unmatched, rules };
  }

  /** 清空全部请求记录与命中计数（含自增序号）。 */
  reset(): void {
    this.db.exec("DELETE FROM requests; DELETE FROM rule_hits; DELETE FROM sqlite_sequence WHERE name = 'requests';");
  }

  close(): void {
    this.db.close();
  }
}
