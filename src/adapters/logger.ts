// Diagnostic logger: keeps a bounded in-memory ring buffer and appends
// JSON lines to a log file so any run can be replayed from runId + events.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEntry } from "../domain/types.ts";
import type { Logger } from "../core/engine.ts";

export class RingLogger implements Logger {
  private readonly entries: LogEntry[] = [];
  private readonly capacity = 5000;

  private readonly logFile: string | null;

  constructor(logFile: string | null) {
    this.logFile = logFile;
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  }

  log(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
      } catch {
        // logging must never break the build loop
      }
    }
  }

  query(runId?: string): LogEntry[] {
    if (!runId) return [...this.entries];
    return this.entries.filter((e) => e.runId === runId);
  }
}
