import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, baseTemplate } from './helpers.ts';
import { DomainError } from '../src/domain/errors.ts';

test('full lifecycle: pending -> provisioning -> ready -> suspended -> resume -> delete', () => {
  const { kernel, clock } = makeKernel();
  kernel.registerTemplate(baseTemplate);

  const inst = kernel.provision({ name: 'dev1', template: 'node-dev' });
  assert.equal(inst.status, 'PROVISIONING'); // slot free, starts immediately

  clock.advance(1000);
  assert.equal(kernel.get('dev1').status, 'READY');

  clock.advance(5000); // idleTimeoutMs
  assert.equal(kernel.get('dev1').status, 'SUSPENDED');

  kernel.resume('dev1');
  assert.equal(kernel.get('dev1').status, 'READY');

  kernel.delete('dev1');
  assert.equal(kernel.query({}).find((i) => i.name === 'dev1')!.status, 'DELETED');

  const history = kernel.history('dev1');
  const transitions = history.map((h) => [h.fromStatus, h.toStatus, h.reason]);
  assert.deepEqual(transitions, [
    [null, 'PENDING', 'provision-requested'],
    ['PENDING', 'PROVISIONING', 'dequeued-for-provisioning'],
    ['PROVISIONING', 'READY', 'provision-complete'],
    ['READY', 'SUSPENDED', 'idle-timeout-5000ms'],
    ['SUSPENDED', 'READY', 'manual-resume'],
    ['READY', 'DELETED', 'delete-requested'],
  ]);
  // run ids are stable and increasing
  assert.deepEqual(history.map((h) => h.runId), history.map((_, i) => history[0].runId.slice(0, -1) + (i + 1)));
  // timestamps are non-decreasing
  for (let i = 1; i < history.length; i++) assert.ok(history[i].at >= history[i - 1].at);
});

test('resume restarts the idle clock (no premature suspend)', () => {
  const { kernel, clock } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  kernel.provision({ name: 'dev1', template: 'node-dev' });
  clock.advance(1000); // ready
  clock.advance(4000); // 1s before timeout
  kernel.delete('dev1'); // reset scenario
  kernel.provision({ name: 'dev2', template: 'node-dev' });
  clock.advance(1000); // ready at t=6000... actually t=11000
  clock.advance(4000); // 1s before timeout
  assert.equal(kernel.get('dev2').status, 'READY');
  clock.advance(1000); // exactly at timeout
  assert.equal(kernel.get('dev2').status, 'SUSPENDED');
  // resume and verify the timer restarts fully
  kernel.resume('dev2');
  clock.advance(4999);
  assert.equal(kernel.get('dev2').status, 'READY');
  clock.advance(1);
  assert.equal(kernel.get('dev2').status, 'SUSPENDED');
});

test('deleted instance is terminal: every operation fails with TERMINAL_STATE', () => {
  const { kernel, clock } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  kernel.provision({ name: 'dev1', template: 'node-dev' });
  clock.advance(1000);
  kernel.delete('dev1');
  assert.throws(() => kernel.resume('dev1'), (e: unknown) => (e as DomainError).code === 'TERMINAL_STATE');
  assert.throws(() => kernel.delete('dev1'), (e: unknown) => (e as DomainError).code === 'TERMINAL_STATE');
  // name can be reused after deletion
  const again = kernel.provision({ name: 'dev1', template: 'node-dev' });
  assert.equal(again.status, 'PROVISIONING');
});

test('resume on non-suspended instance is an invalid transition', () => {
  const { kernel, clock } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  kernel.provision({ name: 'dev1', template: 'node-dev' });
  clock.advance(1000);
  assert.throws(() => kernel.resume('dev1'), (e: unknown) => (e as DomainError).code === 'INVALID_TRANSITION');
});
