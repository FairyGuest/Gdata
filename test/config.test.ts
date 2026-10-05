// Contract/config tests: invalid input must fail with INVALID_CONFIG, distinct from other codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFaultConfig } from '../src/config.ts';
import { ChaosError } from '../src/contracts.ts';

const expectInvalid = (fn: () => unknown, match: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ChaosError && e.code === 'INVALID_CONFIG' && match.test(e.message));

test('valid configs parse with defaults', () => {
  assert.deepEqual(validateFaultConfig('latency', { probability: 0.5, params: { delayMs: 50 } }),
    { probability: 0.5, durationMs: undefined, params: { delayMs: 50 } });
  assert.equal(validateFaultConfig('errorStatus', {}).params?.statusCode, 500);
  assert.equal(validateFaultConfig('truncate', {}).params?.keepRatio, 0.3);
});

test('probability out of range rejected', () => {
  expectInvalid(() => validateFaultConfig('latency', { probability: 1.5 }), /probability/);
  expectInvalid(() => validateFaultConfig('latency', { probability: -0.1 }), /probability/);
  expectInvalid(() => validateFaultConfig('latency', { probability: 'high' }), /probability/);
});

test('fault-specific params validated', () => {
  expectInvalid(() => validateFaultConfig('latency', { params: { delayMs: -5 } }), /delayMs/);
  expectInvalid(() => validateFaultConfig('errorStatus', { params: { statusCode: 200 } }), /statusCode/);
  expectInvalid(() => validateFaultConfig('truncate', { params: { keepRatio: 1.5 } }), /keepRatio/);
  expectInvalid(() => validateFaultConfig('abort', { durationMs: -1 }), /durationMs/);
});
