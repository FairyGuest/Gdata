// Diagnostic logging: every record carries the process run id so a failing
// run can be replayed from logs alone.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  runId: string;
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(logFile: string | null, runId: string = randomUUID()): Logger {
  let stream: fs.WriteStream | null = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  const write = (level: LogLevel, event: string, fields: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, level, event, ...fields });
    stream?.write(line + '\n');
    if (level !== 'info' || process.env.ESB_LOG_STDOUT === '1') {
      process.stdout.write(line + '\n');
    }
  };
  return {
    runId,
    log: write,
    info: (e, f = {}) => write('info', e, f),
    warn: (e, f = {}) => write('warn', e, f),
    error: (e, f = {}) => write('error', e, f),
  };
}
