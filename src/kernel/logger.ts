import type { OrchestratorStore } from '../store/db.ts';

export interface LogEntry {
  runId: string;
  seq: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  data: unknown;
}

export class RunLogger {
  private seq = 0;
  private readonly store: OrchestratorStore;
  readonly runId: string;

  constructor(store: OrchestratorStore, runId: string) {
    this.store = store;
    this.runId = runId;
  }

  log(level: 'info' | 'warn' | 'error', event: string, data: unknown): LogEntry {
    this.seq += 1;
    const entry: LogEntry = { runId: this.runId, seq: this.seq, level, event, data };
    this.store.appendLog(entry);
    return entry;
  }

  info(event: string, data: unknown): LogEntry {
    return this.log('info', event, data);
  }

  warn(event: string, data: unknown): LogEntry {
    return this.log('warn', event, data);
  }

  error(event: string, data: unknown): LogEntry {
    return this.log('error', event, data);
  }
}
