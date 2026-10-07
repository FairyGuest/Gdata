import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, makeConfig, baseTemplate } from './helpers.ts';
import { AppError } from '../src/errors.ts';

test('global concurrency limit queues excess provisions and drains FIFO', () => {
  const { registry, provisioner, clock } = makeStack(makeConfig({ maxConcurrentProvisions: 1 }));
  registry.register(baseTemplate);
  const template = registry.get('node-dev');

  const a = provisioner.provision(template, { envName: 'a', templateName: 'node-dev' });
  assert.equal(a.queued, false);
  const b = provisioner.provision(template, { envName: 'b', templateName: 'node-dev' });
  assert.equal(b.queued, true);
  assert.equal(b.queuePosition, 1);
  const c = provisioner.provision(template, { envName: 'c', templateName: 'node-dev' });
  assert.equal(c.queued, true);
  assert.equal(c.queuePosition, 2);

  assert.equal(provisioner.get('a').state, 'provisioning');
  assert.equal(provisioner.get('b').state, 'pending');
  assert.equal(provisioner.get('c').state, 'pending');

  clock.advance(5000); // a completes; b (FIFO first) takes the slot
  assert.equal(provisioner.get('a').state, 'ready');
  assert.equal(provisioner.get('b').state, 'provisioning');
  assert.equal(provisioner.get('c').state, 'pending');

  clock.advance(5000); // b completes; c takes the slot
  assert.equal(provisioner.get('b').state, 'ready');
  assert.equal(provisioner.get('c').state, 'provisioning');

  clock.advance(5000);
  assert.equal(provisioner.get('c').state, 'ready');

  // FIFO start order is visible in the transition log: b's slot_acquired run
  // happens before c's slot_acquired.
  const bStart = provisioner.history('b').find((h) => h.reason === 'slot_acquired')!;
  const cStart = provisioner.history('c').find((h) => h.reason === 'slot_acquired')!;
  assert.ok(bStart.at < cStart.at, 'b must start before c');
});

test('duplicate active environment name is rejected with 409 CONFLICT_ACTIVE_INSTANCE', () => {
  const { registry, provisioner } = makeStack();
  registry.register(baseTemplate);
  const template = registry.get('node-dev');
  provisioner.provision(template, { envName: 'dup', templateName: 'node-dev' });
  try {
    provisioner.provision(template, { envName: 'dup', templateName: 'node-dev' });
    assert.fail('expected conflict');
  } catch (e) {
    assert.ok(e instanceof AppError);
    assert.equal(e.category, 'CONFLICT_ACTIVE_INSTANCE');
    assert.equal(e.httpStatus, 409);
    assert.equal(e.detail, 'dup');
  }
});

test('two simultaneous provisions of the same name: exactly one succeeds', () => {
  const { registry, provisioner } = makeStack();
  registry.register(baseTemplate);
  const template = registry.get('node-dev');

  const results = [true, true].map(() => {
    try {
      provisioner.provision(template, { envName: 'race', templateName: 'node-dev' });
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof AppError);
      assert.equal(e.category, 'CONFLICT_ACTIVE_INSTANCE');
      return 'conflict';
    }
  });
  assert.deepEqual(results.sort(), ['conflict', 'ok']);
  // only one active instance with that name exists
  const actives = provisioner.list().filter((i) => i.name === 'race' && i.state !== 'deleted');
  assert.equal(actives.length, 1);
});

test('deleting a queued/provisioning environment frees capacity for the queue', () => {
  const { registry, provisioner, clock } = makeStack(makeConfig({ maxConcurrentProvisions: 1 }));
  registry.register(baseTemplate);
  const template = registry.get('node-dev');
  provisioner.provision(template, { envName: 'a', templateName: 'node-dev' });
  provisioner.provision(template, { envName: 'b', templateName: 'node-dev' }); // queued
  provisioner.delete('a'); // frees the slot; b should start immediately
  assert.equal(provisioner.get('a').state, 'deleted');
  assert.equal(provisioner.get('b').state, 'provisioning');
  clock.advance(5000);
  assert.equal(provisioner.get('b').state, 'ready');
});
