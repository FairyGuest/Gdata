/** 运行日志：携带 runId/requestId/关键中间状态/判断理由，支持事后重放。 */
export interface LogEntry {
  seq: number;
  at: number;
  runId: string;
  requestId: string | null;
  event: string;
  state: Record<string, unknown>;
  reason: string;
}

export class RingLogger {
  private entries: LogEntry[] = [];
  private seq = 0;
  private readonly capacity: number;
  private readonly runId: string;

  constructor(capacity: number, runId: string) {
    this.capacity = capacity;
    this.runId = runId;
  }

  log(event: string, state: Record<string, unknown>, reason: string, requestId: string | null = null, at = Date.now()): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, at, runId: this.runId, requestId, event, state, reason };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    return entry;
  }

  recent(limit = 200): LogEntry[] {
    return this.entries.slice(-limit);
  }

  get currentRunId(): string {
    return this.runId;
  }
}

