/**
 * Local demo: starts the service on a real port, submits a valid chain and a
 * broken one, then prints the diagnostics replay of the broken run.
 */
import { loadConfig } from '../src/config.js';
import { SystemClock } from '../src/domain/clock.js';
import { RunStore } from '../src/state/runStore.js';
import { buildApp } from '../src/http/server.js';
import { buildValidChain } from '../src/fixtures/ca.js';

const config = loadConfig();
const app = buildApp({ config, clock: new SystemClock(), store: new RunStore(config.dbPath) });
await app.listen({ port: config.port, host: config.host });
const base = `http://${config.host}:${config.port}`;
console.log(`service listening at ${base}`);

const now = new Date();
const { chain } = buildValidChain(config.masterSecret, now);

const okRes = await fetch(`${base}/v1/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chain }),
});
console.log('valid chain ->', okRes.status, JSON.stringify((await okRes.json()).renewalAdvice));

const broken = [...chain];
broken[1] = { ...broken[1], keyUsage: ['digitalSignature'] };
const badRes = await fetch(`${base}/v1/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chain: broken }),
});
const badBody = await badRes.json() as { runId: string; code: string; linkIndex: number };
console.log(`tampered chain -> ${badRes.status} ${badBody.code} at link ${badBody.linkIndex}`);

const diag = await fetch(`${base}/v1/runs/${badBody.runId}`);
console.log('diagnostics replay ->', JSON.stringify(await diag.json(), null, 2));

await app.close();

