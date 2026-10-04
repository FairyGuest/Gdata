/**
 * One-shot acceptance run: exercises every required scenario in a fixed order,
 * printing request, response and verdict for each. Exit 0 iff all pass.
 */
import assert from 'node:assert/strict';
import { buildApp } from '../src/http/server.js';
import { FixedClock } from '../src/domain/clock.js';
import { RunStore } from '../src/state/runStore.js';
import { buildValidChain, DAY } from '../src/fixtures/ca.js';
import { signCertificate } from '../src/domain/signing.js';
import type { ServiceConfig } from '../src/config.js';
import type { Certificate } from '../src/domain/types.js';

const SECRET = 'accept-master-secret';
const NOW = new Date('2026-06-15T00:00:00.000Z');

const config: ServiceConfig = {
  port: 0,
  host: '127.0.0.1',
  masterSecret: SECRET,
  trustedRoots: ['CN=Demo Root CA'],
  renewSoonDays: 30,
  renewImmediatelyDays: 7,
  maxChainLength: 8,
  dbPath: ':memory:',
};

function resign(cert: Certificate): Certificate {
  const { signature: _drop, ...rest } = cert;
  return { ...rest, signature: signCertificate(SECRET, rest) };
}

interface Scenario {
  name: string;
  run: (app: ReturnType<typeof buildApp>) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: 'S1 full chain passes',
    run: async (app) => {
      const { chain } = buildValidChain(SECRET, NOW, 90);
      const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain } });
      const body = res.json();
      console.log(`  response: status=${res.statusCode} ok=${body.ok} chainLength=${body.chainLength} runId=${body.runId}`);
      console.log(`  renewal: ${JSON.stringify(body.renewalAdvice?.map((a: { subject: string; action: string }) => [a.subject, a.action]))}`);
      assert.equal(res.statusCode, 200);
      assert.equal(body.ok, true);
      assert.equal(body.chainLength, 3);
      assert.ok(body.links.every((l: { signatureValid: boolean; inValidityWindow: boolean }) => l.signatureValid && l.inValidityWindow));
      // Diagnostics replay of the persisted run.
      const diag = (await app.inject({ method: 'GET', url: `/v1/runs/${body.runId}` })).json();
      assert.equal(diag.ok, true);
      assert.equal(diag.steps.length, 3);
      console.log(`  replay: run ${diag.runId} has ${diag.steps.length} recorded steps, all "${diag.steps[0].outcome}"`);
    },
  },
  {
    name: 'S2 broken chain is located at the failing level',
    run: async (app) => {
      const { chain } = buildValidChain(SECRET, NOW);
      chain[0] = resign({ ...chain[0], issuer: 'CN=Rogue CA' });
      const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain } });
      const body = res.json();
      console.log(`  response: status=${res.statusCode} code=${body.code} linkIndex=${body.linkIndex}`);
      console.log(`  reason: ${body.message}`);
      assert.equal(res.statusCode, 422);
      assert.equal(body.code, 'CHAIN_LINK_MISMATCH');
      assert.equal(body.linkIndex, 0);
      const diag = (await app.inject({ method: 'GET', url: `/v1/runs/${body.runId}` })).json();
      assert.equal(diag.code, 'CHAIN_LINK_MISMATCH');
      console.log(`  replay: verdict step recorded as "${diag.steps.at(-1).reason}"`);
    },
  },
  {
    name: 'S3 certificate expiring exactly at evaluation time fails as CERT_EXPIRED',
    run: async (app) => {
      const { chain } = buildValidChain(SECRET, NOW);
      chain[0] = resign({ ...chain[0], notAfter: NOW.toISOString() });
      const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain } });
      const body = res.json();
      console.log(`  response: status=${res.statusCode} code=${body.code} linkIndex=${body.linkIndex} remainingDays=${body.links[0].remainingDays}`);
      assert.equal(res.statusCode, 422);
      assert.equal(body.code, 'CERT_EXPIRED');
      assert.equal(body.linkIndex, 0);
    },
  },
  {
    name: 'S4 renewal thresholds: 30d=RENEW_SOON, 7d=RENEW_IMMEDIATELY, 31d=NONE',
    run: async (app) => {
      for (const [days, expected] of [[30, 'RENEW_SOON'], [7, 'RENEW_IMMEDIATELY'], [31, 'NONE']] as const) {
        const { chain } = buildValidChain(SECRET, NOW);
        chain[0] = resign({ ...chain[0], notAfter: new Date(NOW.getTime() + days * DAY).toISOString() });
        const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain } });
        const body = res.json();
        const advice = body.renewalAdvice[0];
        console.log(`  leaf expires in ${days}d -> action=${advice.action} (expected ${expected})`);
        assert.equal(body.ok, true);
        assert.equal(advice.action, expected);
      }
    },
  },
  {
    name: 'S5 malformed payload is INPUT_INVALID, not a silent success',
    run: async (app) => {
      const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain: [] } });
      const body = res.json();
      console.log(`  response: status=${res.statusCode} code=${body.code}`);
      assert.equal(res.statusCode, 400);
      assert.equal(body.code, 'INPUT_INVALID');
    },
  },
];

const app = buildApp({ config, clock: new FixedClock(NOW), store: new RunStore(':memory:') });
await app.ready();

let failures = 0;
for (const s of scenarios) {
  console.log(`\n[${s.name}]`);
  try {
    await s.run(app);
    console.log('  verdict: PASS');
  } catch (err) {
    failures++;
    console.log(`  verdict: FAIL - ${(err as Error).message}`);
  }
}
await app.close();

console.log(`\n${scenarios.length - failures}/${scenarios.length} scenarios passed`);
if (failures > 0) {
  console.error(`ACCEPTANCE FAILED: ${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('ACCEPTANCE OK');

