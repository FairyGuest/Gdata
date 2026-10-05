export interface RunLogEntry {
  seq: number;
  phase: string;
  message: string;
  data?: unknown;
}

export interface RunLog {
  runId: string;
  seed: number | string;
  startedAt: string;
  entries: RunLogEntry[];
  outcome?: 'success' | 'failure';
  failureCategory?: string;
}

let counter = 0;

export function createRunLog(seed: number | string): RunLog {
  counter += 1;
  return {
    runId: 'run-' + Date.now().toString(36) + '-' + counter,
    seed,
    startedAt: new Date().toISOString(),
    entries: [],
  };
}

export function logStep(log: RunLog, phase: string, message: string, data?: unknown): void {
  log.entries.push({ seq: log.entries.length + 1, phase, message, data });
}
