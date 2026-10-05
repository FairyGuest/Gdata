import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/state/store.ts';
import type { DetectionReport, RunRecord } from '../src/contract/types.ts';

function report(roundId: string, createdAt: string): DetectionReport {
  return {
    testName: 't-store', roundId, totalRuns: 4, classification: 'flaky',
    confidence: 0.875, distribution: { passes: 2, failures: 2 }, firstFailureRun: 1,
    suggestedRetries: 3, reasoning: 'test fixture', createdAt,
  };
}
const RUNS: RunRecord[] = [
  { runIndex: 1, outcome: 'fail', durationMs: 1 },
  { runIndex: 2, outcome: 'pass', durationMs: 1 },
  { runIndex: 3, outcome: 'fail', durationMs: 1 },
  { runIndex: 4, outcome: 'pass', durationMs: 1 },
];

test('persists rounds and returns cross-round trend ordered by time', () => {
  const store = new HistoryStore(':memory:');
  store.saveReport(report('r1', '2026-10-05T10:00:00.000Z'), RUNS);
  store.saveReport(report('r2', '2026-10-05T11:00:00.000Z'), RUNS);
  const trend = store.trend('t-store');
  assert.equal(trend.length, 2);
  assert.deepEqual(trend.map((t) => t.roundId), ['r1', 'r2']);
  assert.equal(trend[0]!.classification, 'flaky');
  assert.equal(trend[0]!.passes, 2);
  assert.equal(trend[0]!.failures, 2);
  store.close();
});

test('latestRound returns the most recent report with replayable run records', () => {
  const store = new HistoryStore(':memory:');
  store.saveReport(report('r1', '2026-10-05T10:00:00.000Z'), RUNS);
  store.saveReport(report('r2', '2026-10-05T11:00:00.000Z'), RUNS);
  const latest = store.latestRound('t-store');
  assert.ok(latest);
  assert.equal(latest.report.roundId, 'r2');
  assert.deepEqual(latest.report.distribution, { passes: 2, failures: 2 });
  assert.equal(latest.runs.length, 4);
  assert.equal(latest.runs[0]!.outcome, 'fail');
  store.close();
});

test('latestRound returns null for unknown test', () => {
  const store = new HistoryStore(':memory:');
  assert.equal(store.latestRound('ghost'), null);
  store.close();
});
