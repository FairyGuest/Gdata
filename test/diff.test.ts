import test from 'node:test';
import assert from 'node:assert/strict';
import { diffReports } from '../src/kernel/diff.js';
import type { Report, TestCase } from '../src/contract/types.js';

function tc(key: string, status: TestCase['status']): TestCase {
  const [file, name] = key.split('::');
  return { key, file: file!, name: name!, status, durationMs: 5, runId: 'r1' };
}

function report(id: number, cases: TestCase[]): Report {
  return {
    id,
    label: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: { total: cases.length, passed: 0, failed: 0, skipped: 0, totalDurationMs: 0 },
    cases,
  };
}

test('diffReports categorizes transitions', () => {
  const base = report(1, [
    tc('a::stay-fail', 'failed'),
    tc('a::now-ok', 'failed'),
    tc('a::gone', 'passed'),
    tc('a::same', 'passed'),
  ]);
  const head = report(2, [
    tc('a::stay-fail', 'failed'),
    tc('a::now-ok', 'passed'),
    tc('a::same', 'passed'),
    tc('a::brand-new-fail', 'failed'),
    tc('a::brand-new-skip', 'skipped'),
  ]);
  const diff = diffReports(base, head);
  assert.equal(diff.baseReportId, 1);
  assert.equal(diff.headReportId, 2);
  assert.deepEqual(diff.counts, {
    new_failure: 1,
    persistent_failure: 1,
    recovered: 1,
    passed: 1,
    skipped: 1,
    removed: 1,
  });
  const byKey = new Map(diff.entries.map((e) => [e.key, e]));
  assert.equal(byKey.get('a::stay-fail')!.category, 'persistent_failure');
  assert.equal(byKey.get('a::now-ok')!.category, 'recovered');
  assert.equal(byKey.get('a::gone')!.category, 'removed');
  assert.equal(byKey.get('a::gone')!.currentStatus, null);
  assert.equal(byKey.get('a::brand-new-fail')!.previousStatus, null);
});


test('diffReports orders entries new_failure > persistent_failure > recovered > passed', () => {
  const base = report(1, [
    tc('a::stay-fail', 'failed'),
    tc('a::now-ok', 'failed'),
    tc('a::same', 'passed'),
    tc('a::was-ok', 'passed'),
  ]);
  const head = report(2, [
    tc('a::same', 'passed'),
    tc('a::now-ok', 'passed'),
    tc('a::stay-fail', 'failed'),
    tc('a::was-ok', 'failed'),
  ]);
  const diff = diffReports(base, head);
  assert.deepEqual(
    diff.entries.map((e) => e.category),
    ['new_failure', 'persistent_failure', 'recovered', 'passed'],
  );
});

