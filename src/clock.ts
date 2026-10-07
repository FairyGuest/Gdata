// Time source contract. The core kernel only depends on Clock,
// so tests and the acceptance script inject VirtualClock.

export interface Clock {
  now(): number; // epoch milliseconds
}

export class SystemClock implements Clock {
  now(): number { return Date.now(); }
}

export class VirtualClock implements Clock {
  private current: number;
  constructor(startMs = 1_760_000_000_000) { this.current = startMs; }
  now(): number { return this.current; }
  advanceSeconds(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`VirtualClock.advanceSeconds requires a non-negative finite number, got ${seconds}`);
    }
    this.current += seconds * 1000;
    return this.current;
  }
}
