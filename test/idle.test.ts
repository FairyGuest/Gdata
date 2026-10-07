import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, baseTemplate, T0 } from './helpers.ts';

function setupReady() {
  const s = makeStack();
  s.registry.register(baseTemplate); // idleTimeoutMs = 10000, provisionDurationMs = 5000
  const template = s.registry.get('node-dev');
  s.provisioner.provision(template, { envName: 'dev-1', templateName: 'node-dev' });
  s.clock.advance(5000); // ready at T0+5000
  assert.equal(s.provisioner.get('dev-1').state, 'ready');
  return s;
}

test('ready instance is auto-suspended after idle timeout', () => {
  const { provisioner, clock } = setupReady();
  clock.advance(10000); // exactly at timeout: strict '>' means still ready
  assert.equal(provisioner.get('dev-1').state, 'ready');
  clock.advance(1); // now past the timeout
  assert.equal(provisioner.get('dev-1').state, 'suspended');
  const history = provisioner.history('dev-1');
  const last = history[history.length - 1];
  assert.equal(last.reason, 'idle_timeout');
  assert.equal(last.to_state, 'suspended');
  assert.equal(last.at, T0 + 5000 + 10000 + 1);
});

test('resume restarts the idle clock', () => {
  const { provisioner, clock } = setupReady();
  clock.advance(15000); // idle-suspended at T0+20000
  assert.equal(provisioner.get('dev-1').state, 'suspended');

  provisioner.resume('dev-1'); // resumed at T0+20000, idle clock restarts
  assert.equal(provisioner.get('dev-1').state, 'ready');

  clock.advance(10000); // exactly at new timeout boundary: still ready
  assert.equal(provisioner.get('dev-1').state, 'ready');
  clock.advance(1); // past the re-timed deadline
  assert.equal(provisioner.get('dev-1').state, 'suspended');

  const reasons = provisioner.history('dev-1').map((h) => h.reason);
  assert.deepEqual(reasons, [
    'provision_requested',
    'slot_acquired',
    'provision_complete',
    'idle_timeout',
    'resume',
    'idle_timeout',
  ]);
});

test('suspended instance is not re-suspended and deleted instance is ignored by idle sweep', () => {
  const { provisioner, clock } = setupReady();
  clock.advance(11000); // suspended
  const runsBefore = provisioner.history('dev-1').length;
  clock.advance(60000); // long idle: no further transitions while suspended
  assert.equal(provisioner.get('dev-1').state, 'suspended');
  assert.equal(provisioner.history('dev-1').length, runsBefore);
  provisioner.delete('dev-1');
  const runsAfterDelete = provisioner.history('dev-1').length;
  clock.advance(60000);
  assert.equal(provisioner.history('dev-1').length, runsAfterDelete);
});
