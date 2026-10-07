// VirtualClock: deterministic time source injected into the kernel.
// All scheduling (provision completion, idle-timeout suspension) runs on it.

interface Timer {
  id: number;
  at: number;
  cb: () => void;
}

export class VirtualClock {
  private nowMs = 0;
  private timers: Timer[] = [];
  private nextId = 1;

  now(): number {
    return this.nowMs;
  }

  setTimeout(cb: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + delayMs, cb });
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return id;
  }

  clearTimeout(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  pendingCount(): number {
    return this.timers.length;
  }

  // Advance virtual time, firing timers in chronological order.
  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.nowMs = next.at;
      next.cb();
    }
    this.nowMs = target;
  }
}
