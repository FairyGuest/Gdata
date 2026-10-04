export interface VirtualClock {
  now(): Date;
}

export class SystemClock implements VirtualClock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements VirtualClock {
  constructor(private readonly fixed: Date) {}
  now(): Date {
    return new Date(this.fixed.getTime());
  }
}

export class MutableClock implements VirtualClock {
  private current: Date;
  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(next: Date): void {
    this.current = new Date(next.getTime());
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

