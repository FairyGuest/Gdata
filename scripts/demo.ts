/** Local demo: walks a full lifecycle against the in-process app with a VirtualClock. */
import { VirtualClock } from '../src/clock.ts';
import { openDb } from '../src/state/db.ts';
import { Store } from '../src/state/store.ts';
import { TemplateRegistry } from '../src/core/registry.ts';
import { Provisioner } from '../src/core/provisioner.ts';
import { buildApp } from '../src/http/server.ts';
import { makeConfig, baseTemplate, T0 } from '../test/helpers.ts';

const cfg = makeConfig({ maxConcurrentProvisions: 2 });
const clock = new VirtualClock(T0);
const store = new Store(openDb(':memory:'));
const registry = new TemplateRegistry(store, clock, cfg);
const provisioner = new Provisioner(store, clock, cfg);
const app = buildApp({ registry, provisioner });

async function call(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload });
  console.log(method + ' ' + url + ' -> ' + res.statusCode + ' ' + JSON.stringify(res.json()));
  return res;
}

console.log('--- register template ---');
await call('POST', '/templates', baseTemplate);

console.log('--- provision two environments (concurrency limit 2) ---');
await call('POST', '/templates/node-dev/provisions', { envName: 'alice', templateName: 'node-dev', overrides: { memoryMb: 4096 } });
await call('POST', '/templates/node-dev/provisions', { envName: 'bob', templateName: 'node-dev' });
console.log('--- third request queues (FIFO) ---');
await call('POST', '/templates/node-dev/provisions', { envName: 'carol', templateName: 'node-dev' });
console.log('--- duplicate name rejected ---');
await call('POST', '/templates/node-dev/provisions', { envName: 'alice', templateName: 'node-dev' });

console.log('--- advance clock past provision duration ---');
clock.advance(5000);
await call('GET', '/environments/alice');
await call('GET', '/environments/carol');

console.log('--- advance clock past idle timeout: alice/bob auto-suspend ---');
clock.advance(11000);
await call('GET', '/environments/alice');

console.log('--- resume alice (idle clock restarts) ---');
await call('POST', '/environments/alice/resume');

console.log('--- delete bob, then operate on it (terminal state) ---');
await call('DELETE', '/environments/bob');
await call('POST', '/environments/bob/resume');

console.log('--- history of alice ---');
await call('GET', '/environments/alice/history');

console.log('--- diagnostics ---');
await call('GET', '/diagnostics');
