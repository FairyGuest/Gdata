// 存储层：SQLite 持久化历史报告（使用 Node 内置 node:sqlite）。

import { DatabaseSync } from "node:sqlite";
import type { Report } from "../contracts/types.ts";
import { notFound, storageFailed } from "../diagnostics/errors.ts";

export class ReportStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
          report_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `);
    } catch (e) {
      throw storageFailed("failed to open database", { dbPath, cause: String(e) });
    }
  }

  save(report: Report): void {
    try {
      this.db
        .prepare("INSERT INTO reports (report_id, created_at, payload) VALUES (?, ?, ?)")
        .run(report.reportId, report.createdAt, JSON.stringify(report));
    } catch (e) {
      throw storageFailed("failed to save report", { reportId: report.reportId, cause: String(e) });
    }
  }

  get(reportId: string): Report {
    try {
      const row = this.db
        .prepare("SELECT payload FROM reports WHERE report_id = ?")
        .get(reportId) as { payload: string } | undefined;
      if (!row) throw notFound(`report not found: ${reportId}`);
      return JSON.parse(row.payload) as Report;
    } catch (e) {
      if ((e as any).code === "NOT_FOUND") throw e;
      throw storageFailed("failed to read report", { reportId, cause: String(e) });
    }
  }

  list(): Array<{ reportId: string; createdAt: string }> {
    try {
      const rows = this.db.prepare("SELECT report_id AS reportId, created_at AS createdAt FROM reports ORDER BY created_at").all() as Array<{ reportId: string; createdAt: string }>;
      return rows.map((r) => ({ reportId: r.reportId, createdAt: r.createdAt }));
    } catch (e) {
      throw storageFailed("failed to list reports", { cause: String(e) });
    }
  }

  close(): void {
    this.db.close();
  }
}

