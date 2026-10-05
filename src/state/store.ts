import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '../contracts/errors.ts';
import type { DiffResult, Rule, Violation } from '../contracts/types.ts';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS rules (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, match_json TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, file TEXT NOT NULL, created_at TEXT NOT NULL, violation_count INTEGER NOT NULL, log_json TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS violations (run_id TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, snippet TEXT NOT NULL)',
].join(';');

const violationKey = (v: Violation): string =>
  [v.file, v.line, v.column, v.rule, v.snippet].join('|');

export class Store {
  private db: DatabaseSync;

  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  replaceRules(rules: Rule[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM rules').run();
      const ins = this.db.prepare('INSERT INTO rules (name, enabled, severity, message, match_json) VALUES (?, ?, ?, ?, ?)');
      for (const r of rules) {
        ins.run(r.name, r.enabled ? 1 : 0, r.severity, r.message, JSON.stringify(r.match));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addRule(rule: Rule): void {
    const existing = this.db.prepare('SELECT name FROM rules WHERE name = ?').get(rule.name);
    if (existing) {
      throw new EngineError('STATE_CONFLICT', 'RULE_EXISTS', 'rule already exists: ' + rule.name);
    }
    this.db.prepare('INSERT INTO rules (name, enabled, severity, message, match_json) VALUES (?, ?, ?, ?, ?)')
      .run(rule.name, rule.enabled ? 1 : 0, rule.severity, rule.message, JSON.stringify(rule.match));
  }

  setRuleEnabled(name: string, enabled: boolean): void {
    const res = this.db.prepare('UPDATE rules SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
    if (Number(res.changes) === 0) {
      throw new EngineError('NOT_FOUND', 'RULE_NOT_FOUND', 'no such rule: ' + name);
    }
  }

  listRules(): Rule[] {
    const rows = this.db.prepare('SELECT name, enabled, severity, message, match_json FROM rules ORDER BY name').all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: String(r.name),
      enabled: Number(r.enabled) === 1,
      severity: String(r.severity) as Rule['severity'],
      message: String(r.message),
      match: JSON.parse(String(r.match_json)),
    }));
  }

  saveRun(runId: string, file: string, violations: Violation[], log: unknown): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO runs (run_id, file, created_at, violation_count, log_json) VALUES (?, ?, ?, ?, ?)')
        .run(runId, file, new Date().toISOString(), violations.length, JSON.stringify(log));
      const ins = this.db.prepare('INSERT INTO violations (run_id, file, line, col, rule, severity, message, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const v of violations) {
        ins.run(runId, v.file, v.line, v.column, v.rule, v.severity, v.message, v.snippet);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getRun(runId: string): { runId: string; file: string; createdAt: string; violations: Violation[]; log: unknown } {
    const run = this.db.prepare('SELECT run_id, file, created_at, log_json FROM runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!run) {
      throw new EngineError('NOT_FOUND', 'RUN_NOT_FOUND', 'no such run: ' + runId);
    }
    return {
      runId: String(run.run_id),
      file: String(run.file),
      createdAt: String(run.created_at),
      violations: this.getViolations(runId),
      log: JSON.parse(String(run.log_json)),
    };
  }

  getViolations(runId: string): Violation[] {
    const rows = this.db.prepare('SELECT file, line, col, rule, severity, message, snippet FROM violations WHERE run_id = ? ORDER BY line, col').all(runId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      file: String(r.file),
      line: Number(r.line),
      column: Number(r.col),
      rule: String(r.rule),
      severity: String(r.severity) as Violation['severity'],
      message: String(r.message),
      snippet: String(r.snippet),
    }));
  }

  diff(fromRunId: string, toRunId: string): DiffResult {
    const from = this.getViolations(fromRunId);
    if (!this.runExists(fromRunId)) throw new EngineError('NOT_FOUND', 'RUN_NOT_FOUND', 'no such run: ' + fromRunId);
    if (!this.runExists(toRunId)) throw new EngineError('NOT_FOUND', 'RUN_NOT_FOUND', 'no such run: ' + toRunId);
    const to = this.getViolations(toRunId);
    const fromKeys = new Map(from.map((v) => [violationKey(v), v]));
    const toKeys = new Map(to.map((v) => [violationKey(v), v]));
    const added = to.filter((v) => !fromKeys.has(violationKey(v)));
    const removed = from.filter((v) => !toKeys.has(violationKey(v)));
    return { fromRunId, toRunId, added, removed };
  }

  private runExists(runId: string): boolean {
    return this.db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(runId) !== undefined;
  }

  close(): void {
    this.db.close();
  }
}


