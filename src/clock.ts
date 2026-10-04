/** Time source contract. All components read time exclusively through Clock. */
export interface Clock {
  /** Current time in milliseconds since Unix epoch. */
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/** Deterministic clock for tests and acceptance runs. */
export class VirtualClock implements Clock {
  private current: number;

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs;
  }

  nowMs(): number {
    return this.current;
  }

  /** Advance the clock by deltaMs. Returns the new time. */
  advance(deltaMs: number): number {
    if (!Number.isFinite(deltaMs)) throw new Error("deltaMs must be finite");
    this.current += deltaMs;
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
