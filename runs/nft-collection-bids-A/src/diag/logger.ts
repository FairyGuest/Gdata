import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DiagOutcome = "accepted" | "rejected" | "error";

export interface DiagSplit {
  readonly payeeUserId: string;
  readonly amount: number;
}

export interface DiagEvent {
  readonly ts: string;
  readonly runId: string;
  readonly commitSeq: number | null;
  readonly op: string;
  readonly bidId: string | null;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  readonly outcome: DiagOutcome;
  readonly httpStatus: number | null;
  readonly reason: string | null;
  readonly decisionBasis: string;
  readonly amount: number | null;
  readonly sellerAmount: number | null;
  readonly royaltyAmount: number | null;
  readonly splits: readonly DiagSplit[];
  readonly snapshot: Record<string, unknown> | null;
  readonly message: string | null;
}

export interface DiagLogger {
  record(event: DiagEvent): void;
  events(limit?: number): readonly DiagEvent[];
  eventsForBid(bidId: string): readonly DiagEvent[];
}

export class JsonlDiagLogger implements DiagLogger {
  private readonly buffer: DiagEvent[] = [];
  private readonly filePath: string | null;

  constructor(filePath: string | null) {
    this.filePath = filePath;
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  record(event: DiagEvent): void {
    this.buffer.push(event);
    if (this.filePath) {
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
    }
  }

  events(limit = 500): readonly DiagEvent[] {
    return this.buffer.slice(-limit);
  }

  eventsForBid(bidId: string): readonly DiagEvent[] {
    return this.buffer.filter((event) => event.bidId === bidId);
  }
}

export class InMemoryDiagLogger implements DiagLogger {
  private readonly buffer: DiagEvent[] = [];

  record(event: DiagEvent): void {
    this.buffer.push(event);
  }

  events(limit = 500): readonly DiagEvent[] {
    return this.buffer.slice(-limit);
  }

  eventsForBid(bidId: string): readonly DiagEvent[] {
    return this.buffer.filter((event) => event.bidId === bidId);
  }
}
