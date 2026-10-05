// Kernel unit tests: probability distribution + decision shapes. Uses seeded rng (mulberry32),
// NOT the kernel under test, so expected values are independent reference points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFaults, mulberry32 } from '../src/kernel.ts';
import type { ActiveFault } from '../src/contracts.ts';

const fault = (over: Partial<ActiveFault>): ActiveFault => ({
  type: 'latency', sessionId: 's1', startedAt: '', stopsAt: null,
  probability: 1, params: { delayMs: 100 }, ...over,
});

test('probability 0 never fires, probability 1 always fires', () => {
  const rng = mulberry32(42);
  const never = decideFaults([fault({ probability: 0 })], 'r1', rng);
  const always = decideFaults([fault({ probability: 1 })], 'r1', rng);
  assert.equal(never.length, 0);
  assert.equal(always.length, 1);
});

test('statistical distribution: p=0.3 over 20000 draws within tolerance', () => {
  const rng = mulberry32(1234);
  const N = 20000;
  let hits = 0;
  for (let i = 0; i < N; i++) {
    if (decideFaults([fault({ probability: 0.3 })], 'r', rng).length > 0) hits++;
  }
  const rate = hits / N;
  // expected 0.3; 5-sigma binomial bound ~ 0.016; assert tight but safe band
  assert.ok(rate > 0.27 && rate < 0.33, `rate ${rate} outside [0.27, 0.33]`);
});

test('independent faults roll independently (p=0.5 each)', () => {
  const rng = mulberry32(7);
  const N = 20000;
  let both = 0, first = 0;
  const f1 = fault({ type: 'latency', sessionId: 'a', probability: 0.5 });
  const f2 = fault({ type: 'abort', sessionId: 'b', probability: 0.5 });
  for (let i = 0; i < N; i++) {
    const d = decideFaults([f1, f2], 'r', rng);
    if (d.some((x) => x.sessionId === 'a')) first++;
    if (d.length === 2) both++;
  }
  assert.ok(Math.abs(first / N - 0.5) < 0.03);
  assert.ok(Math.abs(both / N - 0.25) < 0.03, `joint rate ${both / N} != 0.25`);
});

test('decision amounts come from params', () => {
  const d = decideFaults([
    fault({ type: 'latency', params: { delayMs: 321 } }),
    fault({ type: 'errorStatus', sessionId: 's2', params: { statusCode: 503 } }),
  ], 'r', () => 0);
  assert.equal(d[0].amount, 321);
  assert.equal(d[1].amount, 503);
});
