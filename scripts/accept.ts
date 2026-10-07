/**
 * One-shot acceptance script: walks every required scenario in a fixed order,
 * printing request, response and verdict for each step. Exit 0 on success,
 * non-zero (identifying the failed scenario) otherwise.
 *
 * Runs fully in-process against the real HTTP route layer (app.inject),
 * an in-memory SQLite database and a VirtualClock, so it is deterministic.
 */
import { VirtualClock } from '../src/clock.ts';
import { openDb } from '../src/state/db.ts';
import { Store } from '../src/state/store.ts';
import { TemplateRegistry } from '../src/core/registry.ts';
import { Provisioner } from '../src/core/provisioner.ts';
import { buildApp } from '../src/http/server.ts';
import { makeConfig, baseTemplate, T0 } from '../test/helpers.ts';

let failures = 0;
let stepNo = 0;

function show(label: string, value: unknown) {
  console.log('  ' + label + ': ' + JSON.stringify(value));
}

function check(scenario: string, cond: boolean, detail: string) {
  stepNo++;
  if (cond) {
    console.log('  -> PASS  ' + detail);
  } else {
    failures++;
    console.log('  -> FAIL  ' + detail);
    console.log('     [scenario failed: ' + scenario + ']');
  }
}

const cfg = makeConfig({ maxConcurrentProvisions: 1 });
const clock = new VirtualClock(T0);
const store = new Store(openDb(':memory:'));
const registry = new TemplateRegistry(store, clock, cfg);
const provisioner = new Provisioner(store, clock, cfg);
const app = buildApp({ registry, provisioner });

async function req(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload });
  return { status: res.statusCode, body: res.json() };
}

// ---------- Scenario 1: invalid templates are rejected ----------
console.log('\n[1] Invalid template rejection');
let r = await req('POST', '/templates', { ...baseTemplate, image: '' });
show('request', { image: '' });
show('response', r);
check('invalid-template', r.status === 400 && r.body.error.category === 'VALIDATION_ERROR' && r.body.error.detail === 'image', 'empty image -> 400 VALIDATION_ERROR(image)');

r = await req('POST', '/templates', { ...baseTemplate, features: ['node', 'kubernetes'] });
show('response', r);
check('invalid-template', r.status === 400 && r.body.error.category === 'VALIDATION_ERROR' && r.body.error.detail === 'features.kubernetes', 'non-whitelist feature -> 400, offending feature named');

r = await req('POST', '/templates', { ...baseTemplate, cpu: 99 });
show('response', r);
check('invalid-template', r.status === 400 && r.body.error.category === 'LIMIT_EXCEEDED' && r.body.error.detail === 'cpu', 'cpu above global ceiling -> 400 LIMIT_EXCEEDED(cpu)');

// ---------- Scenario 2: register valid template ----------
console.log('\n[2] Register valid template');
r = await req('POST', '/templates', baseTemplate);
show('response', r);
check('register-template', r.status === 201 && r.body.name === 'node-dev', 'valid template -> 201');

// ---------- Scenario 3: override contract ----------
console.log('\n[3] Provision override contract');
r = await req('POST', '/templates/node-dev/provisions', { envName: 'x', templateName: 'node-dev', overrides: { gpu: 1 } });
show('response', r);
check('override-contract', r.status === 400 && r.body.error.category === 'UNKNOWN_PARAMETER' && r.body.error.detail === 'overrides.gpu', 'unknown override param -> 400 UNKNOWN_PARAMETER(overrides.gpu)');

r = await req('POST', '/templates/node-dev/provisions', { envName: 'x', templateName: 'node-dev', overrides: { cpu: 8 } });
show('response', r);
check('override-contract', r.status === 400 && r.body.error.category === 'LIMIT_EXCEEDED' && r.body.error.detail === 'overrides.cpu', 'upward cpu override -> 400 LIMIT_EXCEEDED(overrides.cpu)');

// ---------- Scenario 4: full lifecycle state machine ----------
console.log('\n[4] Full lifecycle: provision -> ready -> suspend -> resume -> delete');
r = await req('POST', '/templates/node-dev/provisions', { envName: 'life', templateName: 'node-dev', overrides: { cpu: 2 } });
show('response', r);
check('lifecycle', r.status === 201 && r.body.instance.state === 'provisioning' && r.body.instance.cpu === 2, 'provision -> 201, state=provisioning, downward override applied');

clock.advance(5000);
r = await req('GET', '/environments/life');
check('lifecycle', r.body.state === 'ready', 'after provisionDurationMs -> ready');

r = await req('POST', '/environments/life/suspend');
check('lifecycle', r.status === 200 && r.body.state === 'suspended', 'manual suspend -> suspended');

r = await req('POST', '/environments/life/resume');
check('lifecycle', r.status === 200 && r.body.state === 'ready', 'resume -> ready');

r = await req('DELETE', '/environments/life');
check('lifecycle', r.status === 200 && r.body.state === 'deleted', 'delete -> deleted');

r = await req('GET', '/environments/life/history');
show('history', r.body.map((h: any) => [h.run_id, h.from_state, h.to_state, h.reason]));
const seq = r.body.map((h: any) => h.run_id + ':' + h.from_state + '>' + h.to_state + ':' + h.reason);
check('lifecycle', JSON.stringify(seq) === JSON.stringify([
  '1:none>pending:provision_requested',
  '2:pending>provisioning:slot_acquired',
  '3:provisioning>ready:provision_complete',
  '4:ready>suspended:manual_suspend',
  '5:suspended>ready:resume',
  '6:ready>deleted:delete_requested',
]), 'history runs 1..6 with expected transitions and reasons');

r = await req('POST', '/environments/life/resume');
check('lifecycle', r.status === 410 && r.body.error.category === 'TERMINAL_STATE', 'resume on deleted -> 410 TERMINAL_STATE');
r = await req('DELETE', '/environments/life');
check('lifecycle', r.status === 410 && r.body.error.category === 'TERMINAL_STATE', 'delete on deleted -> 410 TERMINAL_STATE');

// ---------- Scenario 5: idle timeout auto-suspend & resume re-timing ----------
console.log('\n[5] Idle timeout auto-suspend and resume re-timing');
await req('POST', '/templates/node-dev/provisions', { envName: 'idle', templateName: 'node-dev' });
clock.advance(5000); // ready at T0+10000
clock.advance(10001); // past idleTimeoutMs=10000
r = await req('GET', '/environments/idle');
check('idle-timeout', r.body.state === 'suspended', 'ready + idle>idleTimeoutMs -> auto suspended');

r = await req('POST', '/environments/idle/resume');
check('idle-timeout', r.body.state === 'ready', 'resume -> ready (idle clock restarts)');
clock.advance(10000); // exactly at boundary: strict '>' keeps it ready
r = await req('GET', '/environments/idle');
check('idle-timeout', r.body.state === 'ready', 'exactly at new timeout boundary -> still ready (re-timed)');
clock.advance(1);
r = await req('GET', '/environments/idle');
check('idle-timeout', r.body.state === 'suspended', 'past re-timed deadline -> suspended again');
const idleHist = (await req('GET', '/environments/idle/history')).body;
check('idle-timeout', idleHist.filter((h: any) => h.reason === 'idle_timeout').length === 2, 'two idle_timeout transitions recorded');

// ---------- Scenario 6: same-name concurrent provision, exactly one wins ----------
console.log('\n[6] Same-name concurrent provision: exactly one succeeds');
const [r1, r2] = await Promise.all([
  req('POST', '/templates/node-dev/provisions', { envName: 'race', templateName: 'node-dev' }),
  req('POST', '/templates/node-dev/provisions', { envName: 'race', templateName: 'node-dev' }),
]);
show('first', { status: r1.status, body: r1.body });
show('second', { status: r2.status, body: r2.body });
const statuses = [r1.status, r2.status].sort();
const conflict = [r1, r2].find((x) => x.status === 409);
check('same-name-race', statuses.join(',') === '201,409' && conflict.body.error.category === 'CONFLICT_ACTIVE_INSTANCE', 'exactly one 201, one 409 CONFLICT_ACTIVE_INSTANCE');

// ---------- Scenario 7: concurrency limit queues FIFO ----------
console.log('\n[7] Global concurrency limit with FIFO queue (max=1)');
// 'race' is provisioning (occupies the single slot)
const q1 = await req('POST', '/templates/node-dev/provisions', { envName: 'q1', templateName: 'node-dev' });
const q2 = await req('POST', '/templates/node-dev/provisions', { envName: 'q2', templateName: 'node-dev' });
check('fifo-queue', q1.status === 202 && q1.body.queued === true && q1.body.queuePosition === 1, 'q1 queued at position 1 (202)');
check('fifo-queue', q2.status === 202 && q2.body.queuePosition === 2, 'q2 queued at position 2 (202)');
clock.advance(5000); // 'race' completes, q1 takes the slot
let s1 = (await req('GET', '/environments/q1')).body.state;
let s2 = (await req('GET', '/environments/q2')).body.state;
check('fifo-queue', s1 === 'provisioning' && s2 === 'pending', 'after one slot frees: q1 provisioning, q2 still pending (FIFO)');
clock.advance(5000);
s2 = (await req('GET', '/environments/q2')).body.state;
check('fifo-queue', s2 === 'provisioning', 'q2 starts only after q1 completes');

// ---------- Scenario 8: diagnostics & filtered queries ----------
console.log('\n[8] Diagnostics and filtered queries');
r = await req('GET', '/diagnostics');
show('diagnostics', { now: r.body.now, queueDepth: r.body.queueDepth, instancesByState: r.body.instancesByState });
check('diagnostics', r.status === 200 && typeof r.body.queueDepth === 'number' && r.body.instancesByState.deleted >= 1, 'diagnostics exposes clock, queue depth, per-state counts');
r = await req('GET', '/environments?state=suspended');
check('diagnostics', r.status === 200 && r.body.every((i: any) => i.state === 'suspended') && r.body.length >= 1, 'filter by state=suspended');
r = await req('GET', '/environments?template=node-dev');
check('diagnostics', r.status === 200 && r.body.every((i: any) => i.template === 'node-dev'), 'filter by template=node-dev');

// ---------- Summary ----------
console.log('\n========================================');
if (failures === 0) {
  console.log('ACCEPTANCE: ALL ' + stepNo + ' CHECKS PASSED');
  process.exit(0);
} else {
  console.log('ACCEPTANCE: ' + failures + ' OF ' + stepNo + ' CHECKS FAILED');
  process.exit(1);
}
