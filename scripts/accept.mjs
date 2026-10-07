// One-shot acceptance drill: exercises every scenario in a fixed order,
// prints request / response / verdict per step, exits non-zero on any failure.
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../src/server.ts';

const DB_DIR = fileURLToPath(new URL('../data', import.meta.url));
const DB_PATH = DB_DIR + '/accept.db';
mkdirSync(DB_DIR, { recursive: true });
rmSync(DB_PATH, { force: true });

const fixture = (name) => JSON.parse(readFileSync(new URL('../fixtures/' + name, import.meta.url), 'utf8'));

let failures = 0;
let step = 0;

function judge(ok, note) {
  step += 1;
  const verdict = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log('  verdict: ' + verdict + (note ? ' 鈥?' + note : ''));
  console.log('');
  return ok;
}

function showRequest(method, url, payload) {
  console.log('  request:  ' + method + ' ' + url + (payload ? ' body=' + JSON.stringify(payload).slice(0, 120) : ''));
}

function showResponse(res, maxLen = 220) {
  const body = res.body.length > maxLen ? res.body.slice(0, maxLen) + '...' : res.body;
  console.log('  response: ' + res.statusCode + ' ' + body);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function run() {
  const { app, store } = buildServer({ dbPath: DB_PATH });

  console.log('STEP 1: valid multi-layer graph -> stable layered order (lexicographic within layer)');
  showRequest('POST', '/orchestrations', fixture('valid-multi-layer.json'));
  const created = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('valid-multi-layer.json') });
  showResponse(created);
  const plan = created.json();
  judge(
    created.statusCode === 201 &&
      eq(plan.startOrder, ['cache', 'db', 'api', 'worker', 'gateway']) &&
      eq(plan.stopOrder, ['gateway', 'worker', 'api', 'db', 'cache']) &&
      eq(plan.layers, [['cache', 'db'], ['api', 'worker'], ['gateway']]),
    'startOrder=' + JSON.stringify(plan.startOrder),
  );
  const version = plan.version;

  console.log('STEP 2: startup simulation advances layer by layer, all healthy');
  showRequest('POST', '/orchestrations/' + version + '/startup');
  const startup = await app.inject({ method: 'POST', url: '/orchestrations/' + version + '/startup' });
  showResponse(startup);
  judge(startup.json().status === 'completed' && startup.json().layers.length === 3, 'status=' + startup.json().status);

  console.log('STEP 3: dependency cycle is rejected with the cycle sequence');
  showRequest('POST', '/orchestrations', fixture('cycle.json'));
  const cyc = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('cycle.json') });
  showResponse(cyc);
  judge(
    cyc.statusCode === 422 && cyc.json().error.code === 'VALIDATION_CYCLE' &&
      eq(cyc.json().error.details.cycle, ['a', 'c', 'b', 'a']),
    'cycle=' + JSON.stringify(cyc.json().error?.details?.cycle),
  );

  console.log('STEP 4: duplicate port is rejected with port and both service names');
  showRequest('POST', '/orchestrations', fixture('port-conflict.json'));
  const pc = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('port-conflict.json') });
  showResponse(pc);
  judge(
    pc.statusCode === 422 && pc.json().error.code === 'VALIDATION_PORT_CONFLICT' &&
      eq(pc.json().error.details.conflicts, [{ port: 9000, services: ['alpha', 'beta'] }]),
    'conflicts=' + JSON.stringify(pc.json().error?.details?.conflicts),
  );

  console.log('STEP 5: env reference to undeclared output key is rejected');
  showRequest('POST', '/orchestrations', fixture('missing-env.json'));
  const me = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('missing-env.json') });
  showResponse(me);
  judge(
    me.statusCode === 422 && me.json().error.code === 'VALIDATION_MISSING_ENV' &&
      eq(me.json().error.details.missing, [{ key: 'MISSING_KEY', referencedBy: ['svc'] }]),
    'missing=' + JSON.stringify(me.json().error?.details?.missing),
  );

  console.log('STEP 6: single-service change yields minimal affected closure, rest skipped');
  showRequest('POST', '/orchestrations/' + version + '/impact', { changedService: 'db' });
  const impact = await app.inject({ method: 'POST', url: '/orchestrations/' + version + '/impact', payload: { changedService: 'db' } });
  showResponse(impact);
  judge(
    eq(impact.json().affected, ['api', 'db', 'gateway', 'worker']) && eq(impact.json().skipped, ['cache']),
    'affected=' + JSON.stringify(impact.json().affected) + ' skipped=' + JSON.stringify(impact.json().skipped),
  );

  console.log('STEP 7: failing health fixture halts the batch at the failing layer');
  const failing = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('failing-health.json') });
  const fv = failing.json().version;
  showRequest('POST', '/orchestrations/' + fv + '/startup');
  const fs = await app.inject({ method: 'POST', url: '/orchestrations/' + fv + '/startup' });
  showResponse(fs);
  judge(
    fs.json().status === 'failed' && fs.json().failure.layer === 1 && eq(fs.json().failure.services, ['api']) &&
      fs.json().layers[2].services[0].status === 'blocked',
    'failure=' + JSON.stringify(fs.json().failure),
  );

  console.log('STEP 8: malformed JSON -> CONTRACT_PARSE_ERROR (not a silent success)');
  showRequest('POST', '/orchestrations', '{not json');
  const bad = await app.inject({ method: 'POST', url: '/orchestrations', headers: { 'content-type': 'application/json' }, payload: '{not json' });
  showResponse(bad);
  judge(bad.statusCode === 400 && bad.json().error.code === 'CONTRACT_PARSE_ERROR', 'code=' + bad.json().error?.code);

  console.log('STEP 9: unknown version -> STATE_CONFLICT, unknown service -> NOT_FOUND');
  showRequest('GET', '/orchestrations/999/plan');
  const nf = await app.inject({ method: 'GET', url: '/orchestrations/999/plan' });
  showResponse(nf);
  const ghost = await app.inject({ method: 'POST', url: '/orchestrations/' + version + '/impact', payload: { changedService: 'ghost' } });
  showResponse(ghost);
  judge(nf.statusCode === 409 && nf.json().error.code === 'STATE_CONFLICT' && ghost.statusCode === 404 && ghost.json().error.code === 'NOT_FOUND');

  console.log('STEP 10: run diagnostics are retrievable by run id (replay key state)');
  showRequest('GET', '/runs/' + plan.runId);
  const run = await app.inject({ method: 'GET', url: '/runs/' + plan.runId });
  showResponse(run);
  judge(run.statusCode === 200 && run.json().log.some((l) => l.includes('stage=plan')), 'logLines=' + run.json().log?.length);

  console.log('STEP 11: SQLite persistence survives a restart; plan queryable by version');
  await app.close();
  const { app: app2 } = buildServer({ dbPath: DB_PATH });
  showRequest('GET', '/orchestrations/' + version + '/plan');
  const persisted = await app2.inject({ method: 'GET', url: '/orchestrations/' + version + '/plan' });
  showResponse(persisted);
  judge(persisted.statusCode === 200 && eq(persisted.json().startOrder, ['cache', 'db', 'api', 'worker', 'gateway']), 'version=' + version);
  await app2.close();

  console.log('='.repeat(60));
  if (failures > 0) {
    console.log('ACCEPTANCE FAILED: ' + failures + ' of ' + step + ' steps failed');
    process.exit(1);
  }
  console.log('ACCEPTANCE PASSED: all ' + step + ' steps green');
  process.exit(0);
}

run().catch((err) => {
  console.error('acceptance script crashed:', err);
  process.exit(2);
});
