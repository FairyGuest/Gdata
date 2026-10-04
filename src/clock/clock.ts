import type { Clock } from '../domain/types.ts';

/** 可注入的虚拟时钟，测试与演示用它控制"当前时间" */
export class VirtualClock implements Clock {
  private current: Date;
  constructor(initial: Date | string) {
    this.current = initial instanceof Date ? new Date(initial) : new Date(initial);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(t: Date | string): void {
    this.current = t instanceof Date ? new Date(t) : new Date(t);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
