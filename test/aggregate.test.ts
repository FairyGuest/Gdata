import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCases, summarize } from '../src/kernel/aggregate.js';
import { parseIngestRequest } from '../src/adapter/ingest.js';
import type { TestCase } from '../src/contract/types.js';

const LIMITS = { maxCasesPerRun: 3, maxTotalCases: 5 };

function tc(key: string, status: TestCase['status'], runId = 'r1'): TestCase {
  const [file, name] = key.split('::');
  return { key, file: file!, name: name!, status, durationMs: 10, runId };
}

test('summarize counts statuses and durations', () => {
  const summary = summarize([tc('a.ts::t1', 'passed'), tc('a.ts::t2', 'failed'), tc('a.ts::t3', 'skipped')]);
  assert.deepEqual(summary, { total: 3, passed: 1, failed: 1, skipped: 1, totalDurationMs: 30 });
});

test('mergeCases dedupes agreeing duplicates, keeping the latest', () => {
  const merged = mergeCases([tc('a.ts::t1', 'passed', 'r1'), tc('a.ts::t1', 'passed', 'r2')], LIMITS);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.runId, 'r2');
});

test('mergeCases rejects conflicting statuses with 409', () => {
  assert.throws(
    () => mergeCases([tc('a.ts::t1', 'passed', 'r1'), tc('a.ts::t1', 'failed', 'r2')], LIMITS),
    (error: unknown) => (error as { code?: string }).code === 'STATUS_CONFLICT',
  );
});

test('mergeCases enforces per-run and total limits with 413', () => {
  assert.throws(
    () => mergeCases([tc('a::1', 'passed'), tc('a::2', 'passed'), tc('a::3', 'passed'), tc('a::4', 'passed')], LIMITS),
    (error: unknown) => (error as { code?: string }).code === 'PAYLOAD_TOO_LARGE',
  );
  const many = Array.from({ length: 6 }, (_, i) => tc('a::' + i, 'passed', 'r' + (i % 2)));
  assert.throws(
    () => mergeCases(many, LIMITS),
    (error: unknown) => (error as { code?: string }).code === 'PAYLOAD_TOO_LARGE',
  );
});

test('parseIngestRequest normalizes status aliases', () => {
  const { cases } = parseIngestRequest({
    runs: [{ runId: 'r1', cases: [
      { file: 'a.ts', name: 't1', status: 'PASS', durationMs: 1 },
      { file: 'a.ts', name: 't2', status: 'error', durationMs: 2 },
      { file: 'a.ts', name: 't3', status: 'pending', durationMs: 3 },
    ] }],
  });
  assert.deepEqual(cases.map((c) => c.status), ['passed', 'failed', 'skipped']);
});

test('parseIngestRequest rejects unknown status and missing fields', () => {
  assert.throws(
    () => parseIngestRequest({ runs: [{ runId: 'r1', cases: [{ file: 'a', name: 'b', status: 'meh', durationMs: 1 }] }] }),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_STATUS',
  );
  assert.throws(
    () => parseIngestRequest({ runs: [{ cases: [] }] }),
    (error: unknown) => (error as { code?: string }).code === 'MISSING_FIELD',
  );
  assert.throws(
    () => parseIngestRequest({}),
    (error: unknown) => (error as { code?: string }).code === 'MISSING_FIELD',
  );
});
