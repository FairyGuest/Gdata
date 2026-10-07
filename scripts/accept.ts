import { readFileSync } from 'node:fs';
import { OrchestratorStore } from '../src/store/db.ts';
import { buildApp } from '../src/http/app.ts';
import { loadConfig } from '../src/config.ts';
import type { OrchestrationDef } from '../src/domain/types.ts';

interface InjectResponse { statusCode: number; body: string; json(): unknown }
type InjectFn = (opts: { method: string; url: string; payload?: unknown }) => Promise<InjectResponse>;

let failures = 0;
let step = 0;

function show(label: string, value: unknown): void {
  console.log('    ' + label + ': ' + JSON.stringify(value));
}

function check(label: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log('  [PASS] ' + label);
  } else {
    failures += 1;
    console.log('  [FAIL] ' + label);
    show('evidence', detail);
  }
}

async function scenario(title: string, fn: () => Promise<void>): Promise<void> {
  step += 1;
  console.log('\n=== Scenario ' + step + ': ' + title + ' ===');
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log('  [FAIL] scenario threw: ' + (err instanceof Error ? err.message : String(err)));
  }
}

const fixture = JSON.parse(readFileSync(new URL('../fixtures/valid-stack.json', import.meta.url), 'utf8')) as OrchestrationDef;

function svc(partial: Record<string, unknown> & { name: string }): Record<string, unknown> {
  return { ports: [], dependsOn: [], env: {}, outputs: [], health: { kind: 'fixture', fixture: 'healthy' }, ...partial };
}

const store = new OrchestratorStore(':memory:');
const config = { ...loadConfig({}), maxServices: 5 };
const built = await buildApp(store, config);
const inject: InjectFn = (o) => built.inject(o);
console.log('driver: ' + built.driver + ' (fastify when installed, mini-fastify-fallback offline)');

await scenario('valid multi-layer graph yields stable, lexicographically ordered plan', async () => {
  console.log('  -> POST /orchestrations (fixture webshop, 5 services, 3 layers)');
  const res = await inject({ method: 'POST', url: '/orchestrations', payload: fixture });
  const body = res.json() as { plan: { startOrder: string[]; stopOrder: string[]; layers: string[][] }; runId: string; version: number };
  show('status', res.statusCode);
  show('startOrder', body.plan?.startOrder);
  show('stopOrder', body.plan?.stopOrder);
  check('HTTP 201', res.statusCode === 201, res.statusCode);
  check('start order = [postgres, redis, api, worker, gateway]',
    JSON.stringify(body.plan?.startOrder) === JSON.stringify(['postgres', 'redis', 'api', 'worker', 'gateway']), body.plan);
  check('stop order is exact reverse',
    JSON.stringify(body.plan?.stopOrder) === JSON.stringify(['gateway', 'worker', 'api', 'redis', 'postgres']), body.plan);
  check('siblings in a layer are lexicographic (postgres before redis)',
    JSON.stringify(body.plan?.layers?.[0]) === JSON.stringify(['postgres', 'redis']), body.plan?.layers);
  check('run id recorded for replay', typeof body.runId === 'string' && body.runId.length > 0, body.runId);
});

await scenario('dependency cycle is rejected and the cycle path is reported', async () => {
  const cyc = { name: 'cyc', services: [
    svc({ name: 'alpha', dependsOn: ['gamma'] }),
    svc({ name: 'beta', dependsOn: ['alpha'] }),
    svc({ name: 'gamma', dependsOn: ['beta'] }),
  ] };
  console.log('  -> POST /orchestrations (alpha->gamma->beta->alpha cycle)');
  const res = await inject({ method: 'POST', url: '/orchestrations', payload: cyc });
  const body = res.json() as { error: { category: string; details: { issues: { code: string; details: { cycle: string[] } }[] } } };
  const issue = body.error?.details?.issues?.find((i) => i.code === 'CYCLE');
  show('status', res.statusCode);
  show('category', body.error?.category);
  show('cycle', issue?.details?.cycle);
  check('HTTP 400 INPUT_ERROR', res.statusCode === 400 && body.error?.category === 'INPUT_ERROR', body);
  check('cycle path = [alpha, gamma, beta, alpha]',
    JSON.stringify(issue?.details?.cycle) === JSON.stringify(['alpha', 'gamma', 'beta', 'alpha']), issue);
});

await scenario('duplicate port declaration is rejected with port and both services', async () => {
  const ports = { name: 'ports', services: [
    svc({ name: 'web', ports: [8080] }),
    svc({ name: 'admin', ports: [8080] }),
  ] };
  console.log('  -> POST /orchestrations (web and admin both claim 8080)');
  const res = await inject({ method: 'POST', url: '/orchestrations', payload: ports });
  const body = res.json() as { error: { category: string; details: { issues: { code: string; details: unknown }[] } } };
  const issue = body.error?.details?.issues?.find((i) => i.code === 'PORT_CONFLICT');
  show('status', res.statusCode);
  show('conflict', issue?.details);
  check('HTTP 400 INPUT_ERROR', res.statusCode === 400 && body.error?.category === 'INPUT_ERROR', body);
  check('conflict details = { port: 8080, services: [web, admin] }',
    JSON.stringify(issue?.details) === JSON.stringify({ port: 8080, services: ['web', 'admin'] }), issue);
});

await scenario('env reference to an undeclared output key is rejected', async () => {
  const envs = { name: 'envs', services: [
    svc({ name: 'db', outputs: ['DSN'] }),
    svc({ name: 'api', dependsOn: ['db'], env: { DATABASE_URL: '$' + '{db.PASSWORD}' } }),
  ] };
  console.log('  -> POST /orchestrations (api references db.PASSWORD, db only outputs DSN)');
  const res = await inject({ method: 'POST', url: '/orchestrations', payload: envs });
  const body = res.json() as { error: { category: string; details: { issues: { code: string; message: string }[] } } };
  const issue = body.error?.details?.issues?.find((i) => i.code === 'ENV_UNRESOLVED');
  show('status', res.statusCode);
  show('message', issue?.message);
  check('HTTP 400 INPUT_ERROR', res.statusCode === 400 && body.error?.category === 'INPUT_ERROR', body);
  check('message names the missing key PASSWORD and service api',
    !!issue && issue.message.includes('PASSWORD') && issue.message.includes('api'), issue);
});

await scenario('single-service change computes the minimal impact closure', async () => {
  const updatedPostgres = fixture.services.find((s) => s.name === 'postgres') as OrchestrationDef['services'][number];
  const changed = { ...updatedPostgres, ports: [5433] };
  console.log('  -> PUT /orchestrations/webshop/services/postgres (port 5432 -> 5433)');
  const res = await inject({ method: 'PUT', url: '/orchestrations/webshop/services/postgres', payload: changed });
  const body = res.json() as { version: number; impact: { affected: string[]; skipped: string[] } };
  show('status', res.statusCode);
  show('affected', body.impact?.affected);
  show('skipped', body.impact?.skipped);
  check('HTTP 200', res.statusCode === 200, res.statusCode);
  check('affected = [api, gateway, postgres, worker]',
    JSON.stringify(body.impact?.affected) === JSON.stringify(['api', 'gateway', 'postgres', 'worker']), body.impact);
  check('skipped = [redis]', JSON.stringify(body.impact?.skipped) === JSON.stringify(['redis']), body.impact);
  check('new version stored', body.version === 2, body.version);
});

await scenario('stored plans are queryable per version', async () => {
  console.log('  -> GET /orchestrations/webshop/plan?version=1 and ?version=2');
  const v1 = await inject({ method: 'GET', url: '/orchestrations/webshop/plan?version=1' });
  const v2 = await inject({ method: 'GET', url: '/orchestrations/webshop/plan?version=2' });
  const p1 = (v1.json() as { plan: { startOrder: string[] } }).plan;
  const p2 = (v2.json() as { plan: { startOrder: string[] } }).plan;
  show('v1 startOrder', p1?.startOrder);
  show('v2 startOrder', p2?.startOrder);
  check('version 1 plan retrievable and correct',
    JSON.stringify(p1?.startOrder) === JSON.stringify(['postgres', 'redis', 'api', 'worker', 'gateway']), p1);
  check('version 2 plan retrievable and identical topology',
    JSON.stringify(p2?.startOrder) === JSON.stringify(['postgres', 'redis', 'api', 'worker', 'gateway']), p2);
  const missing = await inject({ method: 'GET', url: '/orchestrations/webshop/plan?version=99' });
  const mbody = missing.json() as { error: { category: string } };
  check('unknown version -> 404 NOT_FOUND', missing.statusCode === 404 && mbody.error?.category === 'NOT_FOUND', mbody);
});

await scenario('layered execution halts the batch at the unhealthy layer', async () => {
  const broken = { ...fixture, name: 'broken-shop', services: fixture.services.map((s) =>
    s.name === 'api' ? { ...s, health: { kind: 'fixture', fixture: 'unhealthy', detail: 'probe timeout (synthetic)' } } : s) };
  await inject({ method: 'POST', url: '/orchestrations', payload: broken });
  console.log('  -> POST /orchestrations/broken-shop/execute (api health fixture = unhealthy)');
  const res = await inject({ method: 'POST', url: '/orchestrations/broken-shop/execute' });
  const body = res.json() as { execution: { status: string; failedLayer: number; failures: unknown[]; startedServices: string[] }; runId: string };
  show('status', res.statusCode);
  show('execution', body.execution);
  check('HTTP 422 (failure is not reported as success)', res.statusCode === 422, res.statusCode);
  check('status FAILED at layer 1', body.execution?.status === 'FAILED' && body.execution?.failedLayer === 1, body.execution);
  check('only layer-0 services started', JSON.stringify(body.execution?.startedServices) === JSON.stringify(['postgres', 'redis']), body.execution);
  check('failure located on service api', (JSON.stringify(body.execution?.failures?.[0]) ?? '').includes('api'), body.execution?.failures);

  console.log('  -> GET /diagnostics/runs/' + body.runId + ' (replay log)');
  const logs = await inject({ method: 'GET', url: '/diagnostics/runs/' + body.runId });
  const entries = (logs.json() as { entries: { event: string; data: { reason?: string } }[] }).entries;
  const failedEntry = entries.find((e) => e.event === 'layer.failed');
  show('log events', entries.map((e) => e.event));
  check('run log contains layer.failed with a recorded reason', typeof failedEntry?.data?.reason === 'string', failedEntry);
});

await scenario('error categories are distinguishable (state conflict / resource exhausted / not found)', async () => {
  console.log('  -> POST /orchestrations (duplicate name webshop)');
  const dup = await inject({ method: 'POST', url: '/orchestrations', payload: fixture });
  const dupBody = dup.json() as { error: { category: string; code: string } };
  show('duplicate create', { status: dup.statusCode, ...dupBody.error });
  check('duplicate name -> 409 STATE_CONFLICT', dup.statusCode === 409 && dupBody.error?.category === 'STATE_CONFLICT', dupBody);

  const tooMany = { name: 'huge', services: Array.from({ length: 6 }, (_, i) => svc({ name: 'svc' + i })) };
  console.log('  -> POST /orchestrations (6 services, limit is 5)');
  const big = await inject({ method: 'POST', url: '/orchestrations', payload: tooMany });
  const bigBody = big.json() as { error: { category: string; code: string } };
  show('oversized create', { status: big.statusCode, ...bigBody.error });
  check('over limit -> 507 RESOURCE_EXHAUSTED', big.statusCode === 507 && bigBody.error?.category === 'RESOURCE_EXHAUSTED', bigBody);

  console.log('  -> GET /orchestrations/ghost');
  const ghost = await inject({ method: 'GET', url: '/orchestrations/ghost' });
  const ghostBody = ghost.json() as { error: { category: string } };
  check('missing orchestration -> 404 NOT_FOUND', ghost.statusCode === 404 && ghostBody.error?.category === 'NOT_FOUND', ghostBody);
});

await built.close();
store.close();

console.log('\n========================================');
if (failures > 0) {
  console.log('ACCEPTANCE FAILED: ' + failures + ' check(s) failed across ' + step + ' scenarios');
  process.exit(1);
}
console.log('ACCEPTANCE PASSED: all ' + step + ' scenarios green');
