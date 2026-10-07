export interface LogEntry {
  runId: string;
  step: string;
  state?: unknown;
  reason?: string;
  outcome: "ok" | "rejected" | "conflict" | "failed";
}

export interface RunLogger {
  log(entry: LogEntry): void;
}

export class ConsoleRunLogger implements RunLogger {
  log(entry: LogEntry): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  }
}

export class MemoryRunLogger implements RunLogger {
  readonly entries: LogEntry[] = [];
  log(entry: LogEntry): void {
    this.entries.push(entry);
  }
}
