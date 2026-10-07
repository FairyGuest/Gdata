import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, baseTemplate, T0 } from './helpers.ts';
import { AppError } from '../src/errors.ts';

function setup() {
  const s = makeStack();
  s.registry.register(baseTemplate);
  return s;
}

test('full lifecycle: pending -> provisioning -> ready -> suspended -> ready -> deleted', () => {
  const { registry, provisioner, clock } = setup();
  const template = registry.get('node-dev');

  const r = provisioner.provision(template, { envName: 'dev-1', templateName: 'node-dev' });
  assert.equal(r.queued, false);
  assert.equal(r.instance.state, 'provisioning');

  clock.advance(5000); // provisionDurationMs
  assert.equal(provisioner.get('dev-1').state, 'ready');

  provisioner.suspend('dev-1');
  assert.equal(provisioner.get('dev-1').state, 'suspended');

  provisioner.resume('dev-1');
  assert.equal(provisioner.get('dev-1').state, 'ready');

  provisioner.delete('dev-1');
  assert.equal(provisioner.get('dev-1').state, 'deleted');

  // Reference transition log (hand-written, not derived from the kernel):
  // run 1: none->pending provision_requested @T0
  // run 2: pending->provisioning slot_acquired @T0
  // run 3: provisioning->ready provision_complete @T0+5000
  // run 4: ready->suspended manual_suspend @T0+5000
  // run 5: suspended->ready resume @T0+5000
  // run 6: ready->deleted delete_requested @T0+5000
  const history = provisioner.history('dev-1');
  assert.deepEqual(
    history.map((h) => [h.run_id, h.from_state, h.to_state, h.reason, h.at]),
    [
      [1, 'none', 'pending', 'provision_requested', T0],
      [2, 'pending', 'provisioning', 'slot_acquired', T0],
      [3, 'provisioning', 'ready', 'provision_complete', T0 + 5000],
      [4, 'ready', 'suspended', 'manual_suspend', T0 + 5000],
      [5, 'suspended', 'ready', 'resume', T0 + 5000],
      [6, 'ready', 'deleted', 'delete_requested', T0 + 5000],
    ]
  );
});

test('deleted is terminal: every operation fails with TERMINAL_STATE', () => {
  const { registry, provisioner, clock } = setup();
  const template = registry.get('node-dev');
  provisioner.provision(template, { envName: 'dev-1', templateName: 'node-dev' });
  clock.advance(5000);
  provisioner.delete('dev-1');

  for (const op of [
    () => provisioner.resume('dev-1'),
    () => provisioner.suspend('dev-1'),
    () => provisioner.delete('dev-1'),
  ]) {
    try {
      op();
      assert.fail('expected TERMINAL_STATE');
    } catch (e) {
      assert.ok(e instanceof AppError);
      assert.equal(e.category, 'TERMINAL_STATE');
      assert.equal(e.httpStatus, 410);
    }
  }
  // name is free for re-provisioning after deletion
  const again = provisioner.provision(template, { envName: 'dev-1', templateName: 'node-dev' });
  assert.equal(again.instance.state, 'provisioning');
});

test('illegal transitions raise STATE_CONFLICT', () => {
  const { registry, provisioner, clock } = setup();
  const template = registry.get('node-dev');
  provisioner.provision(template, { envName: 'dev-1', templateName: 'node-dev' });
  // still provisioning: cannot resume, cannot suspend
  for (const op of [() => provisioner.resume('dev-1'), () => provisioner.suspend('dev-1')]) {
    try {
      op();
      assert.fail('expected STATE_CONFLICT');
    } catch (e) {
      assert.ok(e instanceof AppError);
      assert.equal(e.category, 'STATE_CONFLICT');
      assert.equal(e.httpStatus, 409);
    }
  }
  clock.advance(5000); // ready
  try {
    provisioner.resume('dev-1'); // ready, not suspended
    assert.fail('expected STATE_CONFLICT');
  } catch (e) {
    assert.equal((e as AppError).category, 'STATE_CONFLICT');
  }
});

test('operations on unknown environment raise NOT_FOUND', () => {
  const { provisioner } = setup();
  try {
    provisioner.resume('ghost');
    assert.fail('expected NOT_FOUND');
  } catch (e) {
    assert.ok(e instanceof AppError);
    assert.equal(e.category, 'NOT_FOUND');
    assert.equal(e.httpStatus, 404);
  }
});
