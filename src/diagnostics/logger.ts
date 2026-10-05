import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface LogEvent {
  runId: string;
  stage: string;            // e.g. "validate", "load", "diff", "store", "decision"
  level: "info" | "warn" | "error";
  message: string;
  state?: Record<string, unknown>;  // key intermediate state for replay
}

// Structured JSON-lines logger. Every event carries a runId so a failing
// run can be replayed from logs/service.log (and stdout).
export class Logger {
  private readonly logFile?: string;
  constructor(logFile?: string) {
    this.logFile = logFile;
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  }
  newRunId(): string {
    return randomUUID();
  }
  emit(event: LogEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    process.stdout.write(line + "\n");
    if (this.logFile) {
      try { appendFileSync(this.logFile, line + "\n"); } catch { /* logging must not break requests */ }
    }
  }
  info(runId: string, stage: string, message: string, state?: Record<string, unknown>): void {
    this.emit({ runId, stage, level: "info", message, state });
  }
  error(runId: string, stage: string, message: string, state?: Record<string, unknown>): void {
    this.emit({ runId, stage, level: "error", message, state });
  }
}
