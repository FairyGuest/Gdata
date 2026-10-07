import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, baseTemplate } from './helpers.ts';
import { DomainError } from '../src/domain/errors.ts';

test('provision with downward override applies reduced quota', () => {
  const { kernel } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  const inst = kernel.provision({ name: 'a', template: 'node-dev', overrides: { cpu: 2, memoryMb: 4096 } });
  assert.deepEqual(inst.resources, { cpu: 2, memoryMb: 4096 });
});

test('override exceeding template limit is rejected with field named', () => {
  const { kernel } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  assert.throws(() => kernel.provision({ name: 'a', template: 'node-dev', overrides: { cpu: 6 } }),
    (e: unknown) => e instanceof DomainError && e.code === 'OVERRIDE_INVALID'
      && (e.details as any).field === 'cpu' && (e.details as any).limit === 4);
});

test('unknown override field is rejected with field named', () => {
  const { kernel } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  assert.throws(() => kernel.provision({ name: 'a', template: 'node-dev', overrides: { gpu: 1 } as any }),
    (e: unknown) => e instanceof DomainError && e.code === 'OVERRIDE_INVALID'
      && (e.details as any).field === 'gpu');
});
