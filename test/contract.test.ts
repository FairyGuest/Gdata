import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunRequest } from '../src/service.ts';
import { ServiceError } from '../src/contract/errors.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig({});
const base = { projectDir: 'fixtures/sample' };

function expectCode(code: string, fn: () => unknown) {
  assert.throws(fn, (err: unknown) =>
    err instanceof ServiceError && (err as ServiceError).code === code);
}

test('accepts a minimal valid request and applies defaults', () => {
  const req = parseRunRequest(base, config);
  assert.equal(req.testCommand, config.defaultTestCommand);
  assert.equal(req.timeoutMs, config.defaultTimeoutMs);
  assert.equal(req.maxMutants, config.maxMutantsPerRun);
});

test('rejects non-object body as INPUT_INVALID', () => {
  expectCode('INPUT_INVALID', () => parseRunRequest('nope', config));
});

test('rejects missing projectDir as INPUT_INVALID', () => {
  expectCode('INPUT_INVALID', () => parseRunRequest({}, config));
});

test('rejects nonexistent projectDir as INPUT_INVALID', () => {
  expectCode('INPUT_INVALID', () => parseRunRequest({ projectDir: 'no/such/dir' }, config));
});

test('rejects unknown mutation types as INPUT_INVALID', () => {
  expectCode('INPUT_INVALID', () => parseRunRequest({ ...base, types: ['Nope'] }, config));
});

test('rejects non-positive timeoutMs as INPUT_INVALID', () => {
  expectCode('INPUT_INVALID', () => parseRunRequest({ ...base, timeoutMs: 0 }, config));
});

test('rejects empty testCommand as INPUT_INVALID', () => {
  expectCode('INPUT_INVALID', () => parseRunRequest({ ...base, testCommand: '  ' }, config));
});

