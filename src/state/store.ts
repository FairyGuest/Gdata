// 状态适配层：SQLite（node:sqlite 内置驱动）。漏洞库、扫描记录、运行日志。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ScanError } from '../contract/errors.ts';
import type { ScanReport, Vulnerability } from '../contract/types.ts';
import type { LogEvent } from '../diagnostics/logger.ts';

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vulnerabilities (
        id TEXT PRIMARY KEY,
        package_name TEXT NOT NULL,
        affected_range TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        fixed_in TEXT
      );
      CREATE TABLE IF NOT EXISTS scans (
        scan_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        report_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        data_json TEXT,
        ts TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  seedVulnerabilities(vulns: Vulnerability[]): number {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get() as { c: number }).c;
    if (count > 0) return 0;
    const stmt = this.db.prepare(
      'INSERT INTO vulnerabilities (id, package_name, affected_range, severity, summary, fixed_in) VALUES (?, ?, ?, ?, ?, ?)');
    for (const v of vulns) stmt.run(v.id, v.packageName, v.affectedRange, v.severity, v.summary, v.fixedIn ?? null);
    return vulns.length;
  }

  listVulnerabilities(): Vulnerability[] {
    const rows = this.db.prepare('SELECT * FROM vulnerabilities').all() as any[];
    return rows.map((r) => ({
      id: r.id, packageName: r.package_name, affectedRange: r.affected_range,
      severity: r.severity, summary: r.summary, fixedIn: r.fixed_in ?? undefined,
    }));
  }

  createScanRecord(scanId: string, runId: string, requestJson: string): void {
    try {
      this.db.prepare('INSERT INTO scans (scan_id, run_id, status, request_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(scanId, runId, 'RUNNING', requestJson, new Date().toISOString());
    } catch (e: any) {
      if (String(e?.message).includes('UNIQUE') || String(e?.code).includes('SQLITE_CONSTRAINT')) {
        throw new ScanError('STATE_CONFLICT', `scanId "${scanId}" already exists`);
      }
      throw e;
    }
  }

  finishScanRecord(scanId: string, status: 'COMPLETED' | 'FAILED', report?: ScanReport): void {
    this.db.prepare('UPDATE scans SET status = ?, report_json = ? WHERE scan_id = ?')
      .run(status, report ? JSON.stringify(report) : null, scanId);
  }

  getScan(scanId: string): { scanId: string; runId: string; status: string; report?: ScanReport } | undefined {
    const r = this.db.prepare('SELECT * FROM scans WHERE scan_id = ?').get(scanId) as any;
    if (!r) return undefined;
    return { scanId: r.scan_id, runId: r.run_id, status: r.status, report: r.report_json ? JSON.parse(r.report_json) : undefined };
  }

  saveLogEvent(e: LogEvent): void {
    this.db.prepare('INSERT INTO run_logs (run_id, seq, level, event, data_json, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.runId, e.seq, e.level, e.event, e.data === undefined ? null : JSON.stringify(e.data), e.ts);
  }

  getRunLogs(runId: string): LogEvent[] {
    const rows = this.db.prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY seq').all(runId) as any[];
    return rows.map((r) => ({ runId: r.run_id, seq: r.seq, level: r.level, event: r.event, data: r.data_json ? JSON.parse(r.data_json) : undefined, ts: r.ts }));
  }

  close(): void { this.db.close(); }
}
