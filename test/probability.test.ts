import test from 'node:test';
import assert from 'node:assert/strict';
import { ChaosEngine } from '../src/kernel/engine';
import { ChaosStore } from '../src/state/store';
import { logStep, mulberry32 } from './helpers';

// Reference counts computed independently of the engine (plain loop over the
// same seeded PRNG) and hardcoded here so the engine cannot grade itself.
const SEED_HALF = 1234;
const EXPECTED_HALF = 987; // count of mulberry32(1234) draws < 0.5 in 2000 draws
const SEED_QUARTER = 7;
const EXPECTED_QUARTER = 1011; // count of mulberry32(7) draws < 0.25 in 4000 draws

function countDecisions(probability: number, n: number, seed: number): { hits: number; events: number } {
  const store = new ChaosStore(':memory:');
  const engine = new ChaosEngine(store, { maxActiveInjections: 4, rng: mulberry32(seed) });
  const session = engine.start({ faultType: 'error_status', probability, durationMs: null, params: { statusCode: 503 } });
  let hits = 0;
  for (let i = 0; i < n; i++) {
    if (engine.decide('req-' + i).length > 0) hits++;
  }
  const events = store.statsForSession(session.id)!.affectedRequests;
  engine.shutdown();
  store.close();
  return { hits, events };
}

test('probability: seeded distribution matches precomputed reference exactly', () => {
  const { hits, events } = countDecisions(0.5, 2000, SEED_HALF);
  logStep('probability', 'seeded p=0.5', { hits, expected: EXPECTED_HALF, events },
    'engine rolls must match independent reference count');
  assert.equal(hits, EXPECTED_HALF);
  assert.equal(events, EXPECTED_HALF);
});

test('probability: p=0.25 observed rate within binomial tolerance', () => {
  const n = 4000;
  const { hits } = countDecisions(0.25, n, SEED_QUARTER);
  const rate = hits / n;
  logStep('probability', 'seeded p=0.25', { hits, rate, expected: EXPECTED_QUARTER },
    'rate must sit in [0.20, 0.30] and match reference');
  assert.equal(hits, EXPECTED_QUARTER);
  assert.ok(rate > 0.2 && rate < 0.3, 'rate out of tolerance: ' + rate);
});

test('probability: p=0 never fires, p=1 always fires', () => {
  assert.equal(countDecisions(0, 500, 42).hits, 0);
  assert.equal(countDecisions(1, 500, 42).hits, 500);
  logStep('probability', 'edge probabilities', { p0: 0, p1: 500 }, 'degenerate probabilities exact');
});