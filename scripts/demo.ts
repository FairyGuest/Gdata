// Local demo: boot target + chaos proxy on default ports, run a short fault show, print history.
import { startService } from '../src/server.ts';
import { startTarget } from '../src/target.ts';

const target = await startTarget(8500);
const svc = await startService({ proxyPort: 8400, targetUrl: 'http://127.0.0.1:8500', dbPath: ':memory:' });
const base = 'http://127.0.0.1:8400';
console.log(`demo up: proxy :8400 -> target :8500 (runId ${svc.runId})`);

const call = async (p: string, m = 'GET', b?: unknown) => {
  const r = await fetch(base + p, { method: m, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.text() };
};

console.log('baseline:', (await call('/api/hello')).status);
const { body } = await call('/chaos/faults/latency/start', 'POST', { probability: 1, durationMs: 2000, params: { delayMs: 400 } });
const sid = JSON.parse(body).started.sessionId;
console.log('latency fault started for 2000ms, session', sid);
const t0 = performance.now();
await call('/api/hello');
console.log('request took', Math.round(performance.now() - t0), 'ms');
await new Promise((r) => setTimeout(r, 2200));
const t1 = performance.now();
await call('/api/hello');
console.log('after auto-stop, request took', Math.round(performance.now() - t1), 'ms');
console.log('session stats:', (await call(`/chaos/sessions/${sid}`)).body);

await svc.close();
target.server.closeAllConnections();
target.server.close();
