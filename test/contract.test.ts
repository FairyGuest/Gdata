import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunRequest } from '../src/contract.ts';
import { AppError } from '../src/errors.ts';

const limits = { maxRuns: 10, maxTestsPerSuite: 5 };
const validTest = { kind: 'scripted', name: 't', outcomes: ['pass'] };

function expectAppError(fn: () => unknown, category: string, messagePart: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, 'expected AppError, got: ' + String(err));
    assert.equal(err.category, category);
    assert.match(err.message, new RegExp(messagePart, 'i'));
    return;
  }
  assert.fail('expected AppError(' + category + ') but nothing was thrown');
}

test('valid request parses into a RunRequest', () => {
  const req = parseRunRequest({ suiteId: 's1', runs: 3, tests: [validTest] }, limits);
  assert.equal(req.suiteId, 's1');
  assert.equal(req.runs, 3);
  assert.equal(req.tests.length, 1);
  assert.deepEqual(req.tests[0], { kind: 'scripted', name: 't', outcomes: ['pass'] });
});

test('non-object body is INPUT_ERROR', () => {
  expectAppError(() => parseRunRequest('nope', limits), 'INPUT_ERROR', 'object');
  expectAppError(() => parseRunRequest(null, limits), 'INPUT_ERROR', 'object');
});

test('missing/empty suiteId is INPUT_ERROR', () => {
  expectAppError(() => parseRunRequest({ runs: 1, tests: [validTest] }, limits), 'INPUT_ERROR', 'suiteId');
  expectAppError(() => parseRunRequest({ suiteId: '  ', runs: 1, tests: [validTest] }, limits), 'INPUT_ERROR', 'suiteId');
});

test('runs must be a positive integer', () => {
  expectAppError(() => parseRunRequest({ suiteId: 's', runs: 0, tests: [validTest] }, limits), 'INPUT_ERROR', 'runs');
  expectAppError(() => parseRunRequest({ suiteId: 's', runs: 2.5, tests: [validTest] }, limits), 'INPUT_ERROR', 'runs');
  expectAppError(() => parseRunRequest({ suiteId: 's', runs: '3', tests: [validTest] }, limits), 'INPUT_ERROR', 'runs');
});

test('runs above the configured maximum is RESOURCE_EXHAUSTED, not INPUT_ERROR', () => {
  expectAppError(
    () => parseRunRequest({ suiteId: 's', runs: 11, tests: [validTest] }, limits),
    'RESOURCE_EXHAUSTED',
    'maximum',
  );
});

test('too many tests is RESOURCE_EXHAUSTED', () => {
  const tests = Array.from({ length: 6 }, (_, i) => ({ kind: 'scripted', name: 't' + i, outcomes: ['pass'] }));
  expectAppError(() => parseRunRequest({ suiteId: 's', runs: 1, tests }, limits), 'RESOURCE_EXHAUSTED', 'too many');
});

test('empty tests array is INPUT_ERROR', () => {
  expectAppError(() => parseRunRequest({ suiteId: 's', runs: 1, tests: [] }, limits), 'INPUT_ERROR', 'tests');
});

test('duplicate test names are rejected', () => {
  expectAppError(
    () => parseRunRequest({ suiteId: 's', runs: 1, tests: [validTest, validTest] }, limits),
    'INPUT_ERROR',
    'duplicate',
  );
});

test('invalid outcome value is INPUT_ERROR', () => {
  expectAppError(
    () => parseRunRequest({ suiteId: 's', runs: 1, tests: [{ kind: 'scripted', name: 't', outcomes: ['maybe'] }] }, limits),
    'INPUT_ERROR',
    'invalid outcome',
  );
});

test('unknown test kind is INPUT_ERROR', () => {
  expectAppError(
    () => parseRunRequest({ suiteId: 's', runs: 1, tests: [{ kind: 'magic', name: 't' }] }, limits),
    'INPUT_ERROR',
    'kind',
  );
});

test('command test requires a non-empty command', () => {
  expectAppError(
    () => parseRunRequest({ suiteId: 's', runs: 1, tests: [{ kind: 'command', name: 't', command: ' ' }] }, limits),
    'INPUT_ERROR',
    'command',
  );
});
