// Time is injected everywhere; the kernel never reads the wall clock.

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

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }

  advanceSeconds(s: number): number {
    return this.advance(s * 1000);
  }
}

