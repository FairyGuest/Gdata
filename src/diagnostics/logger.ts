// 诊断日志：结构化 JSON 行，保留运行编号、关键中间状态与判断理由。

export interface LogRecord {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  runId?: string;
  reportId?: string;
  state?: unknown;
  reason?: string;
}

export interface Logger {
  log(rec: Omit<LogRecord, "ts">): void;
  entries(): LogRecord[];
}

export function createLogger(sink?: (line: string) => void): Logger {
  const buf: LogRecord[] = [];
  const emit = sink ?? ((line: string) => process.stdout.write(line + "\n"));
  return {
    log(rec) {
      const full: LogRecord = { ts: new Date().toISOString(), ...rec };
      buf.push(full);
      emit(JSON.stringify(full));
    },
    entries() {
      return buf.slice();
    },
  };
}
