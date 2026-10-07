import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock } from '../src/kernel/clock.ts';
import { InstanceStore } from '../src/store/sqlite.ts';
import { Provisioner } from '../src/kernel/provisioner.ts';
import { makeKernel, baseTemplate } from './helpers.ts';

test('query filters by template and status', () => {
  const { kernel, clock } = makeKernel();
  kernel.registerTemplate(baseTemplate);
  kernel.registerTemplate({ ...baseTemplate, name: 'py-dev', image: 'registry.local/py:3.12', features: ['git'] });
  kernel.provision({ name: 'a', template: 'node-dev' });
  kernel.provision({ name: 'b', template: 'py-dev' });
  clock.advance(1000);

  assert.deepEqual(kernel.query({ template: 'node-dev' }).map((i) => i.name), ['a']);
  assert.deepEqual(kernel.query({ status: 'READY' }).map((i) => i.name).sort(), ['a', 'b']);
  assert.deepEqual(kernel.query({ template: 'node-dev', status: 'READY' }).map((i) => i.name), ['a']);
});

test('sqlite persists instances and history across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcr-'));
  const dbPath = join(dir, 'registry.db');
  const config = { ...makeKernel().config, dbPath };
  const clock = new VirtualClock();
  {
    const store = new InstanceStore(dbPath);
    const kernel = new Provisioner(clock, store, config);
    kernel.registerTemplate(baseTemplate);
    kernel.provision({ name: 'persisted', template: 'node-dev' });
    clock.advance(1000);
    store.close();
  }
  {
    const store = new InstanceStore(dbPath);
    const inst = store.getByName('persisted');
    assert.equal(inst!.status, 'READY');
    const hist = store.history(inst!.id);
    assert.equal(hist.length, 3);
    assert.deepEqual(hist.map((h) => h.toStatus), ['PENDING', 'PROVISIONING', 'READY']);
    store.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
