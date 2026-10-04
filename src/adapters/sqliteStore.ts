import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, type Certificate, type ChainValidationResult } from '../domain/types.ts';

/**
 * 状态适配层：证书集合与验证运行日志的 SQLite 持久化。
 * 使用 Node 内置 node:sqlite，无原生依赖。
 */
export class CertStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS certs (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        issuer TEXT NOT NULL,
        not_before TEXT NOT NULL,
        not_after TEXT NOT NULL,
        key_usage TEXT NOT NULL,
        signature TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        verdict TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
  }

  /** 批量写入证书；重复 id 视为状态冲突 */
  saveCerts(certs: Certificate[]): number {
    const insert = this.db.prepare(
      'INSERT INTO certs (id, subject, issuer, not_before, not_after, key_usage, signature) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    let count = 0;
    for (const c of certs) {
      try {
        insert.run(c.id, c.subject, c.issuer, c.notBefore, c.notAfter, JSON.stringify(c.keyUsage), c.signature);
        count += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
          throw new AppError('STATE_CONFLICT', '证书 id 已存在: ' + c.id, { certId: c.id });
        }
        throw new AppError('COMPUTATION_FAILURE', '写入证书失败: ' + msg);
      }
    }
    return count;
  }

  clearCerts(): void {
    this.db.exec('DELETE FROM certs');
  }

  getCerts(): Certificate[] {
    const rows = this.db.prepare('SELECT * FROM certs ORDER BY rowid').all() as unknown as Array<Record<string, string>>;
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      issuer: r.issuer,
      notBefore: r.not_before,
      notAfter: r.not_after,
      keyUsage: JSON.parse(r.key_usage) as string[],
      signature: r.signature,
    }));
  }

  /** 记录一次验证运行，包含关键中间状态与判断理由，供重放 */
  recordRun(runId: string, targetId: string, result: ChainValidationResult): void {
    this.db.prepare(
      'INSERT INTO runs (run_id, target_id, evaluated_at, verdict, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(runId, targetId, result.evaluatedAt, result.valid ? 'valid' : 'invalid', JSON.stringify(result));
  }

  getRun(runId: string): { runId: string; targetId: string; evaluatedAt: string; verdict: string; result: ChainValidationResult } | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      targetId: row.target_id,
      evaluatedAt: row.evaluated_at,
      verdict: row.verdict,
      result: JSON.parse(row.detail) as ChainValidationResult,
    };
  }

  listRuns(): Array<{ runId: string; targetId: string; evaluatedAt: string; verdict: string }> {
    const rows = this.db.prepare('SELECT run_id, target_id, evaluated_at, verdict FROM runs ORDER BY rowid').all() as unknown as Array<Record<string, string>>;
    return rows.map((r) => ({ runId: r.run_id, targetId: r.target_id, evaluatedAt: r.evaluated_at, verdict: r.verdict }));
  }

  close(): void {
    this.db.close();
  }
}
