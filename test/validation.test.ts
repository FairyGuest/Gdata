import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, makeConfig, baseTemplate } from './helpers.ts';
import { AppError } from '../src/errors.ts';

function expectError(fn: () => unknown, category: string, detail?: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError, 'expected AppError, got ' + String(e));
    assert.equal(e.category, category);
    if (detail !== undefined) assert.equal(e.detail, detail);
    return e as AppError;
  }
  assert.fail('expected error ' + category + ' but call succeeded');
}

test('rejects template with empty image', () => {
  const { registry } = makeStack();
  const e = expectError(() => registry.register({ ...baseTemplate, image: '  ' }), 'VALIDATION_ERROR', 'image');
  assert.equal(e.httpStatus, 400);
});

test('rejects template with empty name', () => {
  const { registry } = makeStack();
  expectError(() => registry.register({ ...baseTemplate, name: '' }), 'VALIDATION_ERROR', 'name');
});

test('rejects feature outside whitelist and names the feature', () => {
  const { registry } = makeStack();
  const e = expectError(
    () => registry.register({ ...baseTemplate, features: ['node', 'kubernetes'] }),
    'VALIDATION_ERROR',
    'features.kubernetes'
  );
  assert.match(e.message, /kubernetes/);
});

test('rejects non-positive cpu and cpu above global ceiling', () => {
  const { registry } = makeStack();
  expectError(() => registry.register({ ...baseTemplate, cpu: 0 }), 'VALIDATION_ERROR', 'cpu');
  const e = expectError(() => registry.register({ ...baseTemplate, cpu: 9 }), 'LIMIT_EXCEEDED', 'cpu');
  assert.match(e.message, /global max 8/);
});

test('rejects memory above global ceiling', () => {
  const { registry } = makeStack();
  expectError(() => registry.register({ ...baseTemplate, memoryMb: 20000 }), 'LIMIT_EXCEEDED', 'memoryMb');
  expectError(() => registry.register({ ...baseTemplate, memoryMb: -1 }), 'VALIDATION_ERROR', 'memoryMb');
});

test('rejects unknown override parameter and names it', () => {
  const { registry, provisioner } = makeStack();
  registry.register(baseTemplate);
  const template = registry.get('node-dev');
  const e = expectError(
    () => provisioner.provision(template, { envName: 'env1', templateName: 'node-dev', overrides: { gpu: 1 } }),
    'UNKNOWN_PARAMETER',
    'overrides.gpu'
  );
  assert.equal(e.httpStatus, 400);
});

test('rejects override exceeding template limit and names the field', () => {
  const { registry, provisioner } = makeStack();
  registry.register(baseTemplate);
  const template = registry.get('node-dev');
  expectError(
    () => provisioner.provision(template, { envName: 'env1', templateName: 'node-dev', overrides: { cpu: 5 } }),
    'LIMIT_EXCEEDED',
    'overrides.cpu'
  );
  expectError(
    () => provisioner.provision(template, { envName: 'env1', templateName: 'node-dev', overrides: { memoryMb: 9000 } }),
    'LIMIT_EXCEEDED',
    'overrides.memoryMb'
  );
});

test('accepts downward override and applies it to the instance', () => {
  const { registry, provisioner } = makeStack();
  registry.register(baseTemplate);
  const template = registry.get('node-dev');
  const r = provisioner.provision(template, { envName: 'env1', templateName: 'node-dev', overrides: { cpu: 2, memoryMb: 4096 } });
  assert.equal(r.instance.cpu, 2);
  assert.equal(r.instance.memory_mb, 4096);
});

test('whitelist is configurable: feature rejected under custom config', () => {
  const { registry } = makeStack(makeConfig({ featureWhitelist: ['python'] }));
  expectError(() => registry.register(baseTemplate), 'VALIDATION_ERROR', 'features.node');
});
