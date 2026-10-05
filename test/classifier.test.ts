import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classifier.ts';
import type { TestOutcome } from '../src/contract.ts';

const opts = { passTarget: 0.99, maxSuggestedRetries: 10 };
const rep = (o: TestOutcome, n: number): TestOutcome[] => Array(n).fill(o);

test('all-pass suite is stable-pass with confidence 1 - 2^-N', () => {
  const c = classify('t.ok', rep('pass', 5), opts);
  assert.equal(c.category, 'stable-pass');
  assert.equal(c.passCount, 5);
  assert.equal(c.failCount, 0);
  assert.equal(c.firstFailureRun, null);
  assert.equal(c.suggestedRetries, 0);
  // 1 - 2^-5 = 0.96875, rounded to 4 decimals
  assert.equal(c.confidence, 0.9688);
});

test('all-fail suite is stable-fail, retries are pointless', () => {
  const c = classify('t.bad', rep('fail', 4), opts);
  assert.equal(c.category, 'stable-fail');
  assert.equal(c.passCount, 0);
  assert.equal(c.failCount, 4);
  assert.equal(c.firstFailureRun, 1);
  assert.equal(c.suggestedRetries, 0);
  // 1 - 2^-4 = 0.9375
  assert.equal(c.confidence, 0.9375);
});

test('alternating outcomes are flaky with full distribution and first failure run', () => {
  const c = classify('t.alt', ['pass', 'fail', 'pass', 'fail'], opts);
  assert.equal(c.category, 'flaky');
  assert.equal(c.passCount, 2);
  assert.equal(c.failCount, 2);
  assert.equal(c.firstFailureRun, 2);
  // 2 * min(2,2) / 4 = 1
  assert.equal(c.confidence, 1);
  // failRate 0.5 -> ceil(log(0.01)/log(0.5)) - 1 = ceil(6.6439) - 1 = 6
  assert.equal(c.suggestedRetries, 6);
});

test('flaky confidence grows with minority proportion: 1/3 fail beats 1/10 fail', () => {
  const three = classify('t.a', ['fail', 'pass', 'pass'], opts);
  const ten = classify('t.b', ['fail', ...rep('pass', 9)], opts);
  assert.equal(three.category, 'flaky');
  assert.equal(ten.category, 'flaky');
  // 2*1/3 = 0.6667, 2*1/10 = 0.2
  assert.equal(three.confidence, 0.6667);
  assert.equal(ten.confidence, 0.2);
  assert.ok(three.confidence > ten.confidence);
});

test('stable confidence grows with run count', () => {
  const few = classify('t.a', rep('pass', 3), opts);
  const many = classify('t.b', rep('pass', 10), opts);
  assert.equal(few.confidence, 0.875); // 1 - 2^-3
  assert.equal(many.confidence, 0.999); // 1 - 2^-10 = 0.99902... -> 0.999
  assert.ok(many.confidence > few.confidence);
});

test('suggested retries derive from observed fail rate and pass target', () => {
  // failRate 1/3 -> ceil(log(0.01)/log(1/3)) - 1 = ceil(4.1918) - 1 = 4
  const c = classify('t.a', ['fail', 'pass', 'pass'], opts);
  assert.equal(c.suggestedRetries, 4);
  // failRate 0.9 -> 1 retry is enough (0.9^2 = 0.81 > 0.01? no: ceil(log(.01)/log(.9))-1 = ceil(43.7)-1 = 43 -> clamped to 10)
  const hard = classify('t.b', [...rep('fail', 9), 'pass'], opts);
  assert.equal(hard.suggestedRetries, 10);
});

test('first failure run reflects the earliest failing run index (1-based)', () => {
  const c = classify('t.a', ['pass', 'pass', 'fail', 'pass'], opts);
  assert.equal(c.firstFailureRun, 3);
});
