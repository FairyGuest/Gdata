import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, parseStartInjection } from '../src/contracts/parse';
import { InputError, ResourceExhaustedError, StateConflictError } from '../src/contracts/errors';
import { ChaosEngine } from '../src/kernel/engine';
import { ChaosStore } from '../src/state/store';
import { logStep, RUN_ID } from './helpers';

const LIMITS = { maxDelayMs: 60000 };

test('contract: invalid probability is an input_error', () => {
  assert.throws(
    () => parseStartInjection({ faultType: 'latency', probability: 1.5, params: { delayMs: 10 } }, LIMITS),
    (err: unknown) => {
      assert.ok(err instanceof InputError);
      assert.equal(err.category, 'input_error');
      logStep('contract', 'reject probability=1.5', { category: err.category }, 'out of [0,1] must be input_error');
      return true;
    },
  );
});

test('contract: unknown faultType is an input_error', () => {
  assert.throws(
    () => parseStartInjection({ faultType: 'explode', probability: 0.5 }, LIMITS),
    (err: unknown) => err instanceof InputError && err.category === 'input_error',
  );
});

test('contract: latency without delayMs is an input_error', () => {
  assert.throws(
    () => parseStartInjection({ faultType: 'latency', probability: 1 }, LIMITS),
    (err: unknown) => err instanceof InputError,
  );
});

test('contract: truncate keepRatio outside (0,1) is an input_error', () => {
  assert.throws(
    () => parseStartInjection({ faultType: 'truncate', probability: 1, params: { keepRatio: 1.5 } }, LIMITS),
    (err: unknown) => err instanceof InputError,
  );
});

test('contract: valid input parses with defaults', () => {
  const parsed = parseStartInjection({ faultType: 'error_status', probability: 0.25, durationMs: 500 }, LIMITS);
  assert.equal(parsed.faultType, 'error_status');
  assert.equal(parsed.params.statusCode, 503);
  assert.equal(parsed.durationMs, 500);
  logStep('contract', 'defaults applied', { parsed }, 'error_status defaults to 503');
});

test('contract: duplicate active faultType is a state_conflict', () => {
  const store = new ChaosStore(':memory:');
  const engine = new ChaosEngine(store, { maxActiveInjections: 4 });
  engine.start({ faultType: 'latency', probability: 1, durationMs: null, params: { delayMs: 5 } });
  assert.throws(
    () => engine.start({ faultType: 'latency', probability: 0.5, durationMs: null, params: { delayMs: 5 } }),
    (err: unknown) => {
      assert.ok(err instanceof StateConflictError);
      assert.equal(err.category, 'state_conflict');
      logStep('contract', 'duplicate latency rejected', { category: err.category }, 'same faultType already active');
      return true;
    },
  );
  engine.shutdown();
  store.close();
});

test('contract: stopping an unknown injection is a state_conflict', () => {
  const store = new ChaosStore(':memory:');
  const engine = new ChaosEngine(store, { maxActiveInjections: 4 });
  assert.throws(
    () => engine.stop('no-such-id'),
    (err: unknown) => err instanceof StateConflictError && err.category === 'state_conflict',
  );
  engine.shutdown();
  store.close();
});

test('contract: exceeding active injection limit is resource_exhausted', () => {
  const store = new ChaosStore(':memory:');
  const engine = new ChaosEngine(store, { maxActiveInjections: 1 });
  engine.start({ faultType: 'latency', probability: 1, durationMs: null, params: { delayMs: 5 } });
  assert.throws(
    () => engine.start({ faultType: 'truncate', probability: 1, durationMs: null, params: { keepRatio: 0.5 } }),
    (err: unknown) => {
      assert.ok(err instanceof ResourceExhaustedError);
      assert.equal(err.category, 'resource_exhausted');
      logStep('contract', 'limit hit', { category: err.category }, 'maxActiveInjections=1');
      return true;
    },
  );
  engine.shutdown();
  store.close();
});

test('contract: config without targetUrl is an input_error', () => {
  assert.throws(() => parseConfig({ port: 1 }), (err: unknown) => err instanceof InputError);
});

test('contract: run id for replay', () => {
  logStep('contract', 'run id', { RUN_ID }, 'attach to bug reports to replay this run');
});