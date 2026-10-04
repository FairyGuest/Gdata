// 诊断接口：结构化 JSONL 运行日志，支持按 runId 重放。
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LogEvent {
  runId: string;
  seq: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  data?: unknown;
}

export class RunLogger {
  readonly runId: string;
  private seq = 0;
  private file: string;
  private sink?: (e: LogEvent) => void;

  constructor(logDir: string, runId?: string, sink?: (e: LogEvent) => void) {
    this.runId = runId ?? randomUUID();
    this.sink = sink;
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, `run-${this.runId}.jsonl`);
  }

  log(level: LogEvent['level'], event: string, data?: unknown): LogEvent {
    const e: LogEvent = { runId: this.runId, seq: this.seq++, ts: new Date().toISOString(), level, event, data };
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    this.sink?.(e);
    return e;
  }

  info(event: string, data?: unknown) { return this.log('info', event, data); }
  warn(event: string, data?: unknown) { return this.log('warn', event, data); }
  error(event: string, data?: unknown) { return this.log('error', event, data); }
}
