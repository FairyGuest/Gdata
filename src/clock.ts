
export interface Clock {
  nowSec(): number;
}

export class SystemClock implements Clock {
  nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }
}

export class VirtualClock implements Clock {
  private t: number;
  constructor(startSec = 1_700_000_000) {
    this.t = startSec;
  }
  nowSec(): number {
    return this.t;
  }
  advance(sec: number): void {
    this.t += sec;
  }
}
