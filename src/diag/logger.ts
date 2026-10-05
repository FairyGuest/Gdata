export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  context?: unknown;
}

/** In-memory ring-buffer logger with optional stdout mirroring. */
export class RingLogger {
  private readonly entries: LogEntry[] = [];

  constructor(
    private readonly capacity: number,
    private readonly toStdout: boolean,
  ) {}

  log(level: LogLevel, message: string, context?: unknown): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message, context };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    if (this.toStdout) {
      const line = entry.ts + ' [' + level.toUpperCase() + '] ' + message;
      if (level === 'error') console.error(line);
      else console.log(line);
    }
  }

  info(message: string, context?: unknown): void { this.log('info', message, context); }
  warn(message: string, context?: unknown): void { this.log('warn', message, context); }
  error(message: string, context?: unknown): void { this.log('error', message, context); }

  recent(limit?: number): LogEntry[] {
    if (limit === undefined || limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - limit);
  }
}
