import { DatabaseSync } from 'node:sqlite';
import type { RequestRecord } from '../contracts/types.ts';
import { resourceExhausted, computationFailure } from '../contracts/errors.ts';

export interface RecordFilter {
  method?: string;
  path?: string;      // 精确匹配
  matched?: boolean;
}

/**
 * 状态适配层：SQLite 持久化请求记录。
 * seq 自增即全局调用顺序；容量超限抛 RESOURCE_EXHAUSTED。
 */
export class RequestRecorder {
  private db: DatabaseSync;
  private readonly maxRecords: number;

  constructor(options: { file?: string; maxRecords?: number } = {}) {
    this.maxRecords = options.maxRecords ?? 10_000;
    this.db = new DatabaseSync(options.file ?? ':memory:');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT NOT NULL,
        headers TEXT NOT NULL,
        body TEXT NOT NULL,
        route_id TEXT,
        matched INTEGER NOT NULL,
        received_at TEXT NOT NULL
      )
    `);
  }

  record(entry: Omit<RequestRecord, 'seq'>): number {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
    if (count.n >= this.maxRecords) {
      throw resourceExhausted(
        'RECORDER_CAPACITY_EXCEEDED',
        `请求记录已达容量上限 ${this.maxRecords}，请先调用 /__reset`,
        { maxRecords: this.maxRecords },
      );
    }
    try {
      const result = this.db.prepare(`
        INSERT INTO requests (method, path, query, headers, body, route_id, matched, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.method, entry.path, JSON.stringify(entry.query), JSON.stringify(entry.headers),
        entry.body, entry.routeId, entry.matched ? 1 : 0, entry.receivedAt,
      );
      return Number(result.lastInsertRowid);
    } catch (cause) {
      throw computationFailure('RECORDER_INSERT_FAILED', '请求记录写入失败', String(cause));
    }
  }

  list(filter: RecordFilter = {}): RequestRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.method) { clauses.push('method = ?'); params.push(filter.method.toUpperCase()); }
    if (filter.path) { clauses.push('path = ?'); params.push(filter.path); }
    if (filter.matched !== undefined) { clauses.push('matched = ?'); params.push(filter.matched ? 1 : 0); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare(`SELECT * FROM requests${where} ORDER BY seq ASC`).all(...params);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      seq: row.seq as number,
      method: row.method as string,
      path: row.path as string,
      query: JSON.parse(row.query as string),
      headers: JSON.parse(row.headers as string),
      body: row.body as string,
      routeId: row.route_id as string | null,
      matched: row.matched === 1,
      receivedAt: row.received_at as string,
    }));
  }

  count(filter: RecordFilter = {}): number {
    return this.list(filter).length;
  }

  reset(): void {
    this.db.exec('DELETE FROM requests');
    this.db.exec("DELETE FROM sqlite_sequence WHERE name = 'requests'");
  }

  close(): void {
    this.db.close();
  }
}
