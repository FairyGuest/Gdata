// Structured run logging: every operation gets a runId so failures can be replayed.

export interface LogSink {
  write(line: string): void;
}

export class ConsoleSink implements LogSink {
  write(line: string): void { console.error(line); }
}

export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void { this.lines.push(line); }
}

export class RunLogger {
  private seq = 0;
  private sink: LogSink;
  constructor(sink: LogSink) { this.sink = sink; }
  nextRunId(): string {
    this.seq += 1;
    return `run-${String(this.seq).padStart(4, '0')}`;
  }
  log(runId: string, event: string, fields: Record<string, unknown> = {}): void {
    this.sink.write(JSON.stringify({ runId, event, ...fields }));
  }
}
