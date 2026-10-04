import { DatabaseSync } from 'node:sqlite';
import type { VerifyResult } from '../domain/types.js';
import { DomainError } from '../domain/types.js';

export interface RunStep {
  linkIndex: number | null;
  subject: string | null;
  check: string;
  outcome: string;
  reason: string;
}

export interface StoredRun {
  runId: string;
  evaluatedAt: string;
  ok: boolean;
  code: string | null;
  message: string | null;
  linkIndex: number | null;
  result: VerifyResult;
  steps: RunStep[];
}

// State adapter: persists every verification run plus its per-link trace so a
// failure can be replayed from the run id alone.
export class RunStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_runs (
        run_id TEXT PRIMARY KEY,
        evaluated_at TEXT NOT NULL,
        ok INTEGER NOT NULL,
        code TEXT,
        message TEXT,
        link_index INTEGER,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        link_index INTEGER,
        subject TEXT,
        check_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES verification_runs(run_id)
      );
    `);
  }

  private stepsOf(result: VerifyResult): RunStep[] {
    const steps: RunStep[] = result.links.map((l) => ({
      linkIndex: l.index,
      subject: l.subject,
      check: 'link',
      outcome: l.problems.length === 0 && l.signatureValid ? 'pass' : 'fail',
      reason:
        l.problems.length > 0
          ? l.problems.join(',')
          : `signature=${l.signatureValid ? 'valid' : 'invalid'}; remainingDays=${l.remainingDays}; renewal=${l.renewalAction}`,
    }));
    if (!result.ok) {
      steps.push({
        linkIndex: result.linkIndex,
        subject: result.linkIndex !== null && result.links[result.linkIndex]
          ? result.links[result.linkIndex].subject
          : null,
        check: 'verdict',
        outcome: 'fail',
        reason: `${result.code}: ${result.message}`,
      });
    }
    return steps;
  }

  save(result: VerifyResult): void {
    try {
      this.db.prepare(
        'INSERT INTO verification_runs (run_id, evaluated_at, ok, code, message, link_index, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        result.runId,
        result.evaluatedAt,
        result.ok ? 1 : 0,
        result.ok ? null : result.code,
        result.ok ? null : result.message,
        result.ok ? null : result.linkIndex,
        JSON.stringify(result),
      );
    } catch (err) {
      if (err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) {
        throw new DomainError('STATE_CONFLICT', `run id ${result.runId} already persisted`);
      }
      throw new DomainError('STATE_UNAVAILABLE', `failed to persist run: ${(err as Error).message}`);
    }
    const insertStep = this.db.prepare(
      'INSERT INTO run_steps (run_id, seq, link_index, subject, check_name, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.stepsOf(result).forEach((s, seq) => {
      insertStep.run(result.runId, seq, s.linkIndex, s.subject, s.check, s.outcome, s.reason);
    });
  }

  get(runId: string): StoredRun | null {
    const row = this.db.prepare('SELECT * FROM verification_runs WHERE run_id = ?').get(runId) as
      | { run_id: string; evaluated_at: string; ok: number; code: string | null; message: string | null; link_index: number | null; result_json: string }
      | undefined;
    if (!row) return null;
    const steps = this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq').all(runId) as unknown as {
      link_index: number | null; subject: string | null; check_name: string; outcome: string; reason: string;
    }[];
    return {
      runId: row.run_id,
      evaluatedAt: row.evaluated_at,
      ok: row.ok === 1,
      code: row.code,
      message: row.message,
      linkIndex: row.link_index,
      result: JSON.parse(row.result_json) as VerifyResult,
      steps: steps.map((s) => ({
        linkIndex: s.link_index,
        subject: s.subject,
        check: s.check_name,
        outcome: s.outcome,
        reason: s.reason,
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}

