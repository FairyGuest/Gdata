// SQLite state adapter tests: persistence and filtered queries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MutationStore } from '../src/store.ts';
import type { RunReport } from '../src/contracts.ts';

const makeReport = (runId, file, mutants) => ({
  runId,
  status: 'completed',
  projectDir: '/p',
  sourceFile: file,
  testCommand: 'node --test',
  score: mutants.filter((m) => m[2] === 'killed').length / mutants.length,
  total: mutants.length,
  killed: mutants.filter((m) => m[2] === 'killed').length,
  survived: mutants.filter((m) => m[2] === 'survived').length,
  timeout: 0,
  error: 0,
  survivors: [],
  mutants: mutants.map(([id, mutator, status], i) => ({
    id, mutator, file, offset: i * 10, length: 1, replacement: '-', original: '+',
    preview: 'a + b => a - b', status, reason: 'r', durationMs: 1,
  })),
  log: [],
  startedAt: '2026-10-04T00:00:00.000Z',
  durationMs: 1,
});

test('saves and reloads a full run report', () => {
  const store = new MutationStore(':memory:');
  const report = makeReport('R-1', 'src/calc.js', [['M001', 'ArithmeticFlip', 'killed']]);
  store.saveRun(report);
  const loaded = store.getRun('R-1');
  assert.deepEqual(loaded, report);
  assert.equal(store.getRun('missing'), null);
  store.close();
});

test('queries mutants by file and by mutator type', () => {
  const store = new MutationStore(':memory:');
  store.saveRun(makeReport('R-1', 'src/calc.js', [
    ['M001', 'ArithmeticFlip', 'killed'],
    ['M002', 'EqualityFlip', 'survived'],
  ]));
  store.saveRun(makeReport('R-2', 'src/other.js', [
    ['M001', 'ArithmeticFlip', 'survived'],
  ]));
  const byFile = store.queryMutants({ file: 'src/calc.js' });
  assert.equal(byFile.length, 2);
  assert.ok(byFile.every((r) => r.file === 'src/calc.js'));
  const byMutator = store.queryMutants({ mutator: 'ArithmeticFlip' });
  assert.equal(byMutator.length, 2);
  const both = store.queryMutants({ file: 'src/calc.js', mutator: 'EqualityFlip' });
  assert.equal(both.length, 1);
  assert.equal(both[0].status, 'survived');
  const byRun = store.queryMutants({ runId: 'R-2' });
  assert.equal(byRun.length, 1);
  store.close();
});

test('listRuns returns newest first with score summary', () => {
  const store = new MutationStore(':memory:');
  store.saveRun(makeReport('R-1', 'a.js', [['M001', 'ArithmeticFlip', 'killed']]));
  const later = makeReport('R-2', 'b.js', [['M001', 'ArithmeticFlip', 'survived']]);
  later.startedAt = '2026-10-04T01:00:00.000Z';
  store.saveRun(later);
  const runs = store.listRuns();
  assert.deepEqual(runs.map((r) => r.runId), ['R-2', 'R-1']);
  assert.equal(runs[0].score, 0);
  assert.equal(runs[1].score, 1);
  store.close();
});
