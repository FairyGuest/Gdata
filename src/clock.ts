export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private current: number;

  constructor(start?: number) {
    this.current = start ?? Date.now();
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("VirtualClock.advance requires a non-negative finite ms, got " + ms);
    }
    this.current += ms;
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
