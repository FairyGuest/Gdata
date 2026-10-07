import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, baseTemplate } from './helpers.ts';
import { DomainError } from '../src/domain/errors.ts';

test('rejects template with empty image', () => {
  const { kernel } = makeKernel();
  assert.throws(() => kernel.registerTemplate({ ...baseTemplate, image: '' }),
    (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_VALIDATION' && e.message.includes('image'));
});

test('rejects template with feature outside whitelist', () => {
  const { kernel } = makeKernel();
  assert.throws(() => kernel.registerTemplate({ ...baseTemplate, features: ['git', 'kubernetes'] }),
    (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_VALIDATION' && e.message.includes('kubernetes'));
});

test('rejects template with cpu above global limit', () => {
  const { kernel } = makeKernel();
  assert.throws(() => kernel.registerTemplate({ ...baseTemplate, resources: { cpu: 64, memoryMb: 1024 } }),
    (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_VALIDATION' && e.message.includes('cpu'));
});

test('rejects template with non-positive memory', () => {
  const { kernel } = makeKernel();
  assert.throws(() => kernel.registerTemplate({ ...baseTemplate, resources: { cpu: 1, memoryMb: 0 } }),
    (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_VALIDATION' && e.message.includes('memoryMb'));
});

test('accepts a valid template and lists it', () => {
  const { kernel } = makeKernel();
  const t = kernel.registerTemplate(baseTemplate);
  assert.equal(t.name, 'node-dev');
  assert.equal(kernel.listTemplates().length, 1);
});
