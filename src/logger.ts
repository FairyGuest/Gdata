import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LogEvent {
  runId: string;
  op: string;
  decision: string;
  reason: string;
  state?: Record<string, unknown>;
  at?: number;
}

/**
 * Structured run logger. Every decision the kernel makes is recorded with the
 * run id, the intermediate state it observed, and the reason for the outcome,
 * so any failure can be replayed from logs/<runId>.jsonl.
 */
export class RunLogger {
  private readonly file?: string;

  constructor(
    readonly runId: string,
    logDir?: string,
    private readonly echo = false,
  ) {
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      this.file = join(logDir, `${runId}.jsonl`);
    }
  }

  log(event: Omit<LogEvent, "runId">): void {
    const line = JSON.stringify({ runId: this.runId, at: Date.now(), ...event });
    if (this.file) appendFileSync(this.file, line + "\n");
    if (this.echo) console.log(line);
  }
}
