// Run-scoped structured logger. Each check run gets a run-scoped log file so
// failures can be replayed from: run id, key intermediate states, and the
// reason recorded for every judgement.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LogEntry {
  ts: string;
  runId: string;
  stage: string;
  state: string;
  reason?: string;
}

export class RunLogger {
  private readonly logDir: string;
  readonly runRef: string;
  constructor(logDir: string, runRef: string) {
    this.logDir = logDir;
    this.runRef = runRef;
    mkdirSync(logDir, { recursive: true });
  }
  log(stage: string, state: string, reason?: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      runId: this.runRef,
      stage,
      state,
      ...(reason !== undefined ? { reason } : {}),
    };
    appendFileSync(join(this.logDir, `run-${this.runRef}.log`), JSON.stringify(entry) + '\n', 'utf8');
  }
}
