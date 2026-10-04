import type { CheckRequest, Decision } from "../contract/types.ts";

export interface DecisionLogEntry {
  runId: string;
  at: string;
  request: CheckRequest;
  decision: Decision;
}

// In-memory ring buffer of recent decisions for the diagnostics endpoint.
// Each entry carries the run id, the full request, the matched rules and the
// human-readable reasons so failures can be replayed.
export class DecisionLog {
  private entries: DecisionLogEntry[] = [];
  private counter = 0;

  private capacity: number;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  newRunId(): string {
    this.counter += 1;
    return `run-${Date.now().toString(36)}-${this.counter}`;
  }

  record(request: CheckRequest, decision: Decision): void {
    this.entries.push({
      runId: decision.runId,
      at: new Date().toISOString(),
      request,
      decision,
    });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  recent(limit = 50): DecisionLogEntry[] {
    return this.entries.slice(-limit);
  }
}

