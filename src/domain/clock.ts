/** 时间抽象：所有时间判断都通过注入的 Clock 完成，测试用 VirtualClock 控制。 */
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
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error('VirtualClock.advance requires a non-negative finite ms');
    }
    this.current += ms;
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

