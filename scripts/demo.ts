// Local demo: boots the HTTP service on an ephemeral port and walks through
// the main flows with real HTTP requests (fetch is built into Node 24).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock } from '../src/kernel/clock.ts';
import { InstanceStore } from '../src/store/sqlite.ts';
import { Provisioner } from '../src/kernel/provisioner.ts';
import { buildServer } from '../src/adapters/http.ts';
import type { ServiceConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'dcr-demo-'));
const config: ServiceConfig = {
  port: 0,
  dbPath: join(dir, 'demo.db'),
  featureWhitelist: ['git', 'docker', 'node'],
  maxCpu: 8,
  maxMemoryMb: 16384,
  maxConcurrentProvisions: 2,
  maxQueueSize: 4,
  provisionDurationMs: 1000,
};

const clock = new VirtualClock();
const store = new InstanceStore(config.dbPath);
const kernel = new Provisioner(clock, store, config);
const server = buildServer(kernel, clock);

await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const base = 'http://localhost:' + port;
console.log('demo server on ' + base);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  console.log(method + ' ' + path + ' -> ' + res.status, JSON.stringify(json));
  return { status: res.status, json };
}

await call('POST', '/templates', { name: 'bad', image: '', features: [], resources: { cpu: 1, memoryMb: 1 }, idleTimeoutMs: 1000 });
await call('POST', '/templates', { name: 'node-dev', image: 'registry.local/node:20', features: ['git', 'node'], resources: { cpu: 4, memoryMb: 8192 }, idleTimeoutMs: 5000 });
await call('POST', '/instances', { name: 'demo1', template: 'node-dev', overrides: { cpu: 2 } });
await call('POST', '/instances', { name: 'demo1', template: 'node-dev' }); // 409
await call('POST', '/clock/advance', { ms: 1000 });
await call('GET', '/instances/demo1');
await call('POST', '/clock/advance', { ms: 5000 }); // idle timeout
await call('GET', '/instances/demo1');
await call('POST', '/instances/demo1/resume');
await call('GET', '/instances/demo1/history');
await call('DELETE', '/instances/demo1');
await call('POST', '/instances/demo1/resume'); // 410 terminal
await call('GET', '/diagnostics');

server.close();
store.close();
rmSync(dir, { recursive: true, force: true });
console.log('demo done');
