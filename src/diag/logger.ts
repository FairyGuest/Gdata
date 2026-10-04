/**
 * Diagnostic interface.
 *
 * Run ids are monotonic counters allocated by the service (never derived from
 * wall-clock time or request arrival order). Each terminal run records the
 * order state transition, royalty split and the concrete decision basis so a
 * failing scenario can be replayed from the log alone.
 */

import { ErrorCategory, ErrorReason } from '../errors.js';

export interface SettlementDiag {
  grossPrice: number;
  royaltyBps: number;
  royaltyAmount: number;
  sellerProceeds: number;
  royaltyRecipient: string;
  payer: string;
  payee: string;
}

export type RunDecision = 'accepted' | 'rejected';

export interface DiagEvent {
  runId: string;
  action: string;
  request: unknown;
  decision: RunDecision;
  category: ErrorCategory | null;
  reason: ErrorReason | 'ok' | null;
  httpStatus: number;
  orderId: string | null;
  tokenId: string | null;
  transition: { from: string; to: string } | null;
  settlement: SettlementDiag | null;
  commitSeq: number | null;
  basis: string;
  recordedAtStep: number;
}

export type DiagSink = (event: DiagEvent) => void;

export class DiagLogger {
  private counter = 0;
  private readonly events: DiagEvent[] = [];

  constructor(
    private readonly sink: DiagSink | null = null,
    private readonly echo = true,
  ) {}

  /** Allocate the next deterministic run id, e.g. `run-0007`. */
  begin(action: string, request: unknown): string {
    this.counter += 1;
    const runId = `run-${String(this.counter).padStart(4, '0')}`;
    // Beginnings are echoed only; the terminal event is the durable record.
    if (this.echo) {
      console.log(`[diag] ${runId} begin action=${action} request=${safeStringify(request)}`);
    }
    return runId;
  }

  record(event: DiagEvent): DiagEvent {
    this.events.push(event);
    if (this.sink) this.sink(event);
    if (this.echo) {
      console.log(`[diag] ${event.runId} ${event.decision} http=${event.httpStatus} reason=${event.reason ?? 'ok'} ${event.basis}`);
    }
    return event;
  }

  list(): readonly DiagEvent[] {
    return this.events;
  }

  get(runId: string): DiagEvent | undefined {
    return this.events.find((event) => event.runId === runId);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
