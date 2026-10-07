export interface Clock {
  now(): number;
}

/** Deterministic clock for tests and local runs; time only moves via advance(). */
export class VirtualClock implements Clock {
  private current: number;
  private listeners: Array<() => void> = [];
  constructor(start = 1_000_000) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error('cannot advance clock backwards');
    this.current += ms;
    for (const l of this.listeners) l();
  }
  onTick(listener: () => void): void {
    this.listeners.push(listener);
  }
}

/** Wall-clock implementation for the live server; ticks periodically so idle checks run. */
export class SystemClock implements Clock {
  private timer: ReturnType<typeof setInterval> | null = null;
  now(): number {
    return Date.now();
  }
  start(tickMs: number, listener: () => void): void {
    this.timer = setInterval(listener, tickMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
