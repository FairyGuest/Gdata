import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/kernel/classifier.ts';
import { ServiceError } from '../src/contract/errors.ts';
import type { RunOutcome } from '../src/contract/types.ts';

const OPTS = { targetReliability: 0.99, maxRetries: 5 };
const rep = (o: RunOutcome, n: number): RunOutcome[] => Array.from({ length: n }, () => o);

test('all pass => stable_pass, confidence 1 - 2^-3 = 0.875', () => {
  const r = classify(rep('pass', 3), OPTS);
  assert.equal(r.classification, 'stable_pass');
  assert.equal(r.confidence, 0.875);
  assert.equal(r.suggestedRetries, 0);
  assert.equal(r.distribution, null);
  assert.equal(r.firstFailureRun, null);
});

test('all fail => stable_fail, confidence 1 - 2^-3 = 0.875, no retries', () => {
  const r = classify(rep('fail', 3), OPTS);
  assert.equal(r.classification, 'stable_fail');
  assert.equal(r.confidence, 0.875);
  assert.equal(r.suggestedRetries, 0);
});

test('mixed 2 pass / 1 fail => flaky with hand-computed confidence and retry count', () => {
  const r = classify(['pass', 'fail', 'pass'], OPTS);
  assert.equal(r.classification, 'flaky');
  // (2*1/3) * (1 - 2^-3) = 0.6667 * 0.875 = 0.5833
  assert.equal(r.confidence, 0.5833);
  assert.deepEqual(r.distribution, { passes: 2, failures: 1 });
  assert.equal(r.firstFailureRun, 2);
  // ceil(ln(0.01)/ln(1/3)) - 1 = ceil(4.1918) - 1 = 4
  assert.equal(r.suggestedRetries, 4);
});

test('flaky confidence: 1 failure in 3 runs beats 1 failure in 10 runs', () => {
  const three = classify(['fail', 'pass', 'pass'], OPTS);
  const ten = classify([...rep('pass', 9), 'fail'], OPTS);
  assert.equal(three.confidence, 0.5833);
  // (2*1/10) * (1 - 2^-10) = 0.2 * 0.9990234375 = 0.1998
  assert.equal(ten.confidence, 0.1998);
  assert.ok(three.confidence > ten.confidence);
  assert.equal(ten.firstFailureRun, 10);
});

test('alternating 6 runs => perfectly balanced flaky, retries capped at maxRetries', () => {
  const outcomes: RunOutcome[] = ['pass', 'fail', 'pass', 'fail', 'pass', 'fail'];
  const r = classify(outcomes, OPTS);
  assert.equal(r.classification, 'flaky');
  // 1.0 * (1 - 2^-6) = 0.984375 -> 0.9844
  assert.equal(r.confidence, 0.9844);
  assert.deepEqual(r.distribution, { passes: 3, failures: 3 });
  assert.equal(r.firstFailureRun, 2);
  // ceil(ln(0.01)/ln(0.5)) - 1 = 7 - 1 = 6, capped to 5
  assert.equal(r.suggestedRetries, 5);
});

test('confidence grows with run count for stable tests', () => {
  const c5 = classify(rep('pass', 5), OPTS).confidence;
  const c10 = classify(rep('pass', 10), OPTS).confidence;
  assert.equal(c5, 0.9688);
  assert.ok(c10 > c5);
});

test('zero runs => INPUT_ERROR', () => {
  assert.throws(() => classify([], OPTS), (e: unknown) => e instanceof ServiceError && e.code === 'INPUT_ERROR');
});
