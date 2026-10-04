/** Time source contract. The kernel never reads the system clock directly. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Deterministic clock for tests and demos; only moves when told to. */
export class VirtualClock implements Clock {
  private current: number;

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error('VirtualClock.advance requires a non-negative finite delta, got ' + ms);
    }
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
