import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate, mergeOverrides } from '../src/contract/template.ts';
import { ParamValidationError } from '../src/errors.ts';
import { readFileSync } from 'node:fs';

const template = parseTemplate(JSON.parse(readFileSync('fixtures/template.json', 'utf8')));

function capture(fn: () => unknown): ParamValidationError {
  try { fn(); } catch (e) { return e as ParamValidationError; }
  throw new Error('expected function to throw');
}

test('merge: defaults applied when no overrides', () => {
  const { config, ttlSeconds } = mergeOverrides(template, undefined, undefined);
  assert.deepEqual(config, {
    imageTag: 'latest',
    replicas: 1,
    enableDebug: false,
    databaseUrl: 'sqlite:///:memory:',
  });
  assert.equal(ttlSeconds, 3600);
});

test('merge: valid overrides win over defaults', () => {
  const { config, ttlSeconds } = mergeOverrides(template, { replicas: 3, enableDebug: true }, 600);
  assert.equal(config.replicas, 3);
  assert.equal(config.enableDebug, true);
  assert.equal(config.imageTag, 'latest');
  assert.equal(ttlSeconds, 600);
});

test('reject: unknown parameter names the offending key', () => {
  const err = capture(() => mergeOverrides(template, { nonexistent: 1 }, undefined));
  assert.ok(err instanceof ParamValidationError);
  assert.equal(err.category, 'validation');
  assert.match(err.message, /nonexistent/);
  assert.deepEqual(err.details.unknownKeys, ['nonexistent']);
});

test('reject: type mismatch names key, expected and actual types', () => {
  const err = capture(() => mergeOverrides(template, { replicas: 'three' }, undefined));
  assert.ok(err instanceof ParamValidationError);
  assert.equal(err.category, 'validation');
  assert.match(err.message, /replicas expected number got string/);
});

test('reject: boolean given for string param', () => {
  const err = capture(() => mergeOverrides(template, { imageTag: true }, undefined));
  assert.ok(err instanceof ParamValidationError);
  assert.match(err.message, /imageTag expected string got boolean/);
});

test('reject: ttl out of bounds', () => {
  assert.ok(capture(() => mergeOverrides(template, undefined, 0)) instanceof ParamValidationError);
  assert.ok(capture(() => mergeOverrides(template, undefined, 86401)) instanceof ParamValidationError);
  assert.ok(capture(() => mergeOverrides(template, undefined, 1.5)) instanceof ParamValidationError);
});

test('reject: malformed template surfaces parse error', () => {
  assert.ok(capture(() => parseTemplate({ name: '', services: [], params: {} })) instanceof ParamValidationError);
  assert.ok(capture(() => parseTemplate({ name: 'x', services: ['a'], params: { p: { type: 'date' } } })) instanceof ParamValidationError);
});
