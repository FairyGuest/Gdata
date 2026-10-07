// Clock abstraction. All lease expiry logic reads time exclusively through
// this interface so tests and the acceptance script can drive time manually.

export interface Clock {
  now(): number; // milliseconds since epoch (virtual or real)
}

export class VirtualClock implements Clock {
  private t: number;
  constructor(start = 1_000_000) { this.t = start; }
  now(): number { return this.t; }
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("VirtualClock.advance requires ms >= 0");
    this.t += ms;
    return this.t;
  }
  set(ms: number): number { this.t = ms; return this.t; }
}

export class SystemClock implements Clock {
  now(): number { return Date.now(); }
}

