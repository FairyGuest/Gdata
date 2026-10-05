// State adapter: SQLite-backed persistence for rule sets and check history.
// Uses node:sqlite (Node >= 22.5 built-in). All state conflicts surface as
// STATE_CONFLICT; missing entities as NOT_FOUND.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rule, RunDiff, RunSummary, Severity, Violation } from '../contracts/types.ts';
import { EngineError } from '../contracts/errors.ts';
import { validateRule } from '../core/matcher.ts';
import { compareViolations } from '../core/engine.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  severity TEXT NOT NULL,
  target TEXT NOT NULL,
  message TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  files_checked INTEGER NOT NULL,
  violation_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS violations (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_violations_run ON violations(run_id);
CREATE INDEX IF NOT EXISTS idx_violations_fp ON violations(fingerprint);
`;

interface ViolationRow {
  file: string; line: number; col: number; rule: string;
  severity: string; message: string; excerpt: string; fingerprint: string;
}

function rowToViolation(r: ViolationRow): Violation {
  return {
    file: r.file, line: r.line, column: r.col, rule: r.rule,
    severity: r.severity as Severity, message: r.message,
    excerpt: r.excerpt, fingerprint: r.fingerprint,
  };
}

export class LintStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }
  close(): void { this.db.close(); }

  // ---- rules ----
  listRules(): Rule[] {
    const rows = this.db.prepare('SELECT * FROM rules ORDER BY name').all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: r.name as string,
      enabled: r.enabled === 1,
      severity: r.severity as Severity,
      target: JSON.parse(r.target as string),
      ...(r.message != null ? { message: r.message as string } : {}),
    }));
  }

  addRule(raw: unknown): Rule {
    const rule = validateRule(raw);
    const exists = this.db.prepare('SELECT 1 FROM rules WHERE name = ?').get(rule.name);
    if (exists) {
      throw new EngineError('STATE_CONFLICT', `rule "${rule.name}" already exists; use PUT to replace`);
    }
    this.db.prepare('INSERT INTO rules (name, enabled, severity, target, message, updated_at) VALUES (?,?,?,?,?,?)')
      .run(rule.name, rule.enabled ? 1 : 0, rule.severity, JSON.stringify(rule.target), rule.message ?? null, new Date().toISOString());
    return rule;
  }

  replaceRules(rawRules: unknown[]): Rule[] {
    if (!Array.isArray(rawRules)) throw new EngineError('INPUT_ERROR', 'rules payload must be an array');
    const rules = rawRules.map((r) => validateRule(r));
    const seen = new Set<string>();
    for (const r of rules) {
      if (seen.has(r.name)) throw new EngineError('INPUT_ERROR', `duplicate rule name in payload: "${r.name}"`);
      seen.add(r.name);
    }
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM rules');
      const stmt = this.db.prepare('INSERT INTO rules (name, enabled, severity, target, message, updated_at) VALUES (?,?,?,?,?,?)');
      for (const r of rules) stmt.run(r.name, r.enabled ? 1 : 0, r.severity, JSON.stringify(r.target), r.message ?? null, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rules;
  }

  setRuleEnabled(name: string, enabled: boolean): Rule {
    const res = this.db.prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE name = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), name);
    if (res.changes === 0) throw new EngineError('NOT_FOUND', `rule "${name}" not found`);
    return this.getRule(name);
  }

  getRule(name: string): Rule {
    const r = this.db.prepare('SELECT * FROM rules WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!r) throw new EngineError('NOT_FOUND', `rule "${name}" not found`);
    return {
      name: r.name as string,
      enabled: r.enabled === 1,
      severity: r.severity as Severity,
      target: JSON.parse(r.target as string),
      ...(r.message != null ? { message: r.message as string } : {}),
    };
  }

  deleteRule(name: string): void {
    const res = this.db.prepare('DELETE FROM rules WHERE name = ?').run(name);
    if (res.changes === 0) throw new EngineError('NOT_FOUND', `rule "${name}" not found`);
  }

  // ---- runs ----
  saveRun(filesChecked: number, violations: Violation[]): number {
    this.db.exec('BEGIN');
    try {
      const res = this.db.prepare("INSERT INTO runs (created_at, status, files_checked, violation_count) VALUES (?,?,?,?)")
        .run(new Date().toISOString(), 'completed', filesChecked, violations.length);
      const runId = Number(res.lastInsertRowid);
      const stmt = this.db.prepare('INSERT INTO violations (run_id, file, line, col, rule, severity, message, excerpt, fingerprint) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const v of violations) {
        stmt.run(runId, v.file, v.line, v.column, v.rule, v.severity, v.message, v.excerpt, v.fingerprint);
      }
      this.db.exec('COMMIT');
      return runId;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listRuns(): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY id').all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      status: r.status as RunSummary['status'],
      filesChecked: r.files_checked as number,
      violationCount: r.violation_count as number,
    }));
  }

  getRun(id: number): { summary: RunSummary; violations: Violation[] } {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) throw new EngineError('NOT_FOUND', `run ${id} not found`);
    const rows = this.db.prepare('SELECT * FROM violations WHERE run_id = ?').all(id) as unknown as ViolationRow[];
    return {
      summary: {
        id: r.id as number,
        createdAt: r.created_at as string,
        status: r.status as RunSummary['status'],
        filesChecked: r.files_checked as number,
        violationCount: r.violation_count as number,
      },
      violations: rows.map(rowToViolation).sort(compareViolations),
    };
  }

  diffRuns(fromId: number, toId: number): RunDiff {
    const from = this.getRun(fromId);
    const to = this.getRun(toId);
    const fromFps = new Map(from.violations.map((v) => [v.fingerprint, v]));
    const toFps = new Map(to.violations.map((v) => [v.fingerprint, v]));
    const added = to.violations.filter((v) => !fromFps.has(v.fingerprint));
    const removed = from.violations.filter((v) => !toFps.has(v.fingerprint));
    return { fromRunId: fromId, toRunId: toId, added, removed };
  }
}
