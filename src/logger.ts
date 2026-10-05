/**
 * Diagnostics layer: structured run logs.
 * Each request gets a runId; log entries record key intermediate state
 * and the reasoning behind outcomes so failures can be replayed.
 */
import { randomUUID } from "node:crypto";

export interface LogEntry {
  runId: string;
  ts: string;
  event: string;
  detail?: unknown;
}

const RING_CAPACITY = 500;
const ring: LogEntry[] = [];

export function newRunId(): string {
  return randomUUID();
}

export function log(runId: string, event: string, detail?: unknown): void {
  const entry: LogEntry = { runId, ts: new Date().toISOString(), event, detail: detail ?? null };
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export function recentLogs(limit = 100, runId?: string): LogEntry[] {
  const filtered = runId ? ring.filter((e) => e.runId === runId) : ring;
  return filtered.slice(-limit);
}

export function clearLogs(): void {
  ring.length = 0;
}
