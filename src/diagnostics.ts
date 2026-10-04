/**
 * Diagnostics: an in-memory ring buffer of structured lifecycle events.
 * Every kernel decision is recorded with a run id, the key intermediate
 * state observed, and the reason for the outcome, so failures can be
 * replayed from logs alone. Exposed read-only via /diagnostics routes.
 */
export interface DiagnosticEvent {
  seq: number;
  runId: string;
  op: 'issue' | 'verify' | 'refresh' | 'revoke';
  jti: string | null;
  atMs: number;
  outcome: 'success' | 'failure';
  /** ErrorCode on failure, null on success. */
  reason: string | null;
  /** Key intermediate state that informed the decision. */
  state: Record<string, unknown>;
}

export class DiagnosticLog {
  private events: DiagnosticEvent[] = [];
  private seq = 0;
  constructor(private readonly capacity = 1000) {}

  record(e: Omit<DiagnosticEvent, 'seq'>): DiagnosticEvent {
    const event: DiagnosticEvent = { ...e, seq: ++this.seq };
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return event;
  }

  list(runId?: string): DiagnosticEvent[] {
    return runId ? this.events.filter((e) => e.runId === runId) : [...this.events];
  }
}
