import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, baseTemplate } from './helpers.ts';
import { DomainError } from '../src/domain/errors.ts';

test('same-name concurrent provisioning: exactly one succeeds', () => {
  const { kernel } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  const results = [kernel.provision({ name: 'dup', template: 'node-dev' })];
  let conflict: DomainError | null = null;
  try {
    results.push(kernel.provision({ name: 'dup', template: 'node-dev' }));
  } catch (e) {
    conflict = e as DomainError;
  }
  assert.equal(results.length, 1);
  assert.ok(conflict);
  assert.equal(conflict!.code, 'NAME_CONFLICT');
  assert.equal((conflict!.details as any).name, 'dup');
});

test('concurrency cap queues extra requests and drains FIFO', () => {
  const { kernel, clock } = makeKernel({ maxConcurrentProvisions: 1, provisionDurationMs: 1000 });
  kernel.registerTemplate(baseTemplate);
  kernel.provision({ name: 'first', template: 'node-dev' });
  kernel.provision({ name: 'second', template: 'node-dev' });
  kernel.provision({ name: 'third', template: 'node-dev' });

  assert.equal(kernel.get('first').status, 'PROVISIONING');
  assert.equal(kernel.get('second').status, 'PENDING');
  assert.equal(kernel.get('third').status, 'PENDING');

  clock.advance(1000); // first completes
  assert.equal(kernel.get('first').status, 'READY');
  assert.equal(kernel.get('second').status, 'PROVISIONING');
  assert.equal(kernel.get('third').status, 'PENDING');

  clock.advance(1000); // second completes
  assert.equal(kernel.get('second').status, 'READY');
  assert.equal(kernel.get('third').status, 'PROVISIONING');

  clock.advance(1000);
  assert.equal(kernel.get('third').status, 'READY');
});

test('queue full yields RESOURCE_EXHAUSTED', () => {
  const { kernel } = makeKernel({ maxConcurrentProvisions: 1, maxQueueSize: 2 });
  kernel.registerTemplate(baseTemplate);
  kernel.provision({ name: 'a', template: 'node-dev' });
  kernel.provision({ name: 'b', template: 'node-dev' });
  kernel.provision({ name: 'c', template: 'node-dev' });
  assert.throws(() => kernel.provision({ name: 'd', template: 'node-dev' }),
    (e: unknown) => (e as DomainError).code === 'RESOURCE_EXHAUSTED');
});

test('deleting a queued instance frees the slot for the next in line', () => {
  const { kernel, clock } = makeKernel({ maxConcurrentProvisions: 1, provisionDurationMs: 1000 });
  kernel.registerTemplate(baseTemplate);
  kernel.provision({ name: 'a', template: 'node-dev' });
  kernel.provision({ name: 'b', template: 'node-dev' });
  kernel.delete('a'); // cancel mid-provision
  assert.equal(kernel.get('b').status, 'PROVISIONING');
  clock.advance(1000);
  assert.equal(kernel.get('b').status, 'READY');
});
