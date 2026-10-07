// One-shot acceptance script. Exercises every required scenario in a fixed
// order against an in-process kernel + real SQLite file, printing each
// request, response and verdict. Exits 0 only if all scenarios pass.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock } from '../src/kernel/clock.ts';
import { InstanceStore } from '../src/store/sqlite.ts';
import { Provisioner } from '../src/kernel/provisioner.ts';
import type { ServiceConfig } from '../src/config.ts';
import type { DomainError } from '../src/domain/errors.ts';

const config: ServiceConfig = {
  port: 0,
  dbPath: ':memory:',
  featureWhitelist: ['git', 'docker', 'node'],
  maxCpu: 8,
  maxMemoryMb: 16384,
  maxConcurrentProvisions: 1,
  maxQueueSize: 4,
  provisionDurationMs: 1000,
};

const TEMPLATE = {
  name: 'node-dev',
  image: 'registry.local/node:20',
  features: ['git', 'node'],
  resources: { cpu: 4, memoryMb: 8192 },
  idleTimeoutMs: 5000,
};

let failures = 0;
let step = 0;

function report(title: string, ok: boolean, detail: unknown) {
  step++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [step ' + step + '] ' + title);
  console.log('  -> ' + JSON.stringify(detail));
  if (!ok) failures++;
}

function expectError(label: string, fn: () => unknown, code: string, check?: (e: DomainError) => boolean) {
  try {
    fn();
    report(label, false, { expected: 'error ' + code, got: 'success' });
  } catch (e) {
    const err = e as DomainError;
    const ok = err.code === code && (!check || check(err));
    report(label, ok, { expected: code, got: err.code ?? 'none', details: err.details ?? null });
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dcr-accept-'));
const dbPath = join(dir, 'accept.db');
const clock = new VirtualClock();
const store = new InstanceStore(dbPath);
const kernel = new Provisioner(clock, store, config);

console.log('=== Scenario 1: invalid templates are rejected ===');
expectError('empty image', () => kernel.registerTemplate({ ...TEMPLATE, image: '' }),
  'TEMPLATE_VALIDATION', (e) => e.message.includes('image'));
expectError('feature outside whitelist', () => kernel.registerTemplate({ ...TEMPLATE, features: ['git', 'k8s'] }),
  'TEMPLATE_VALIDATION', (e) => e.message.includes('k8s'));
expectError('cpu above global limit', () => kernel.registerTemplate({ ...TEMPLATE, resources: { cpu: 99, memoryMb: 1024 } }),
  'TEMPLATE_VALIDATION', (e) => e.message.includes('cpu'));
expectError('non-positive memory', () => kernel.registerTemplate({ ...TEMPLATE, resources: { cpu: 1, memoryMb: -5 } }),
  'TEMPLATE_VALIDATION', (e) => e.message.includes('memoryMb'));

console.log('\n=== Scenario 2: provision override contract ===');
kernel.registerTemplate(TEMPLATE);
expectError('override above template limit names the field', () =>
  kernel.provision({ name: 'ov1', template: 'node-dev', overrides: { cpu: 6 } }),
  'OVERRIDE_INVALID', (e) => (e.details as any).field === 'cpu' && (e.details as any).limit === 4);
expectError('unknown override field is named', () =>
  kernel.provision({ name: 'ov2', template: 'node-dev', overrides: { gpu: 1 } as any }),
  'OVERRIDE_INVALID', (e) => (e.details as any).field === 'gpu');
const ov = kernel.provision({ name: 'ov3', template: 'node-dev', overrides: { cpu: 2, memoryMb: 2048 } });
report('downward override applies reduced quota', ov.resources.cpu === 2 && ov.resources.memoryMb === 2048, ov.resources);
kernel.delete('ov3');

console.log('\n=== Scenario 3: full lifecycle state machine ===');
kernel.provision({ name: 'life', template: 'node-dev' });
report('starts PROVISIONING (slot free)', kernel.get('life').status === 'PROVISIONING', kernel.get('life').status);
clock.advance(1000);
report('READY after provision duration', kernel.get('life').status === 'READY', kernel.get('life').status);
clock.advance(5000);
report('auto-SUSPENDED after idle timeout', kernel.get('life').status === 'SUSPENDED', kernel.get('life').status);
kernel.resume('life');
report('resume -> READY', kernel.get('life').status === 'READY', kernel.get('life').status);
kernel.delete('life');
report('delete -> DELETED (terminal)', store.getByName('life')!.status === 'DELETED', store.getByName('life')!.status);
const hist = kernel.history('life');
report('transition log has runId/reason/at for all 6 transitions',
  hist.length === 6 && hist.every((h) => h.runId && h.reason && typeof h.at === 'number'),
  hist.map((h) => [h.runId, h.fromStatus, h.toStatus, h.reason, h.at]));
expectError('resume on deleted instance fails as TERMINAL_STATE', () => kernel.resume('life'), 'TERMINAL_STATE');
expectError('delete on deleted instance fails as TERMINAL_STATE', () => kernel.delete('life'), 'TERMINAL_STATE');

console.log('\n=== Scenario 4: idle timeout auto-suspend + resume retiming ===');
kernel.provision({ name: 'idle', template: 'node-dev' });
clock.advance(1000); // READY
clock.advance(4999);
report('still READY 1ms before timeout', kernel.get('idle').status === 'READY', kernel.get('idle').status);
clock.advance(1);
report('SUSPENDED exactly at timeout', kernel.get('idle').status === 'SUSPENDED', kernel.get('idle').status);
kernel.resume('idle');
clock.advance(4999);
report('resume restarts idle clock (READY at timeout-1ms)', kernel.get('idle').status === 'READY', kernel.get('idle').status);
clock.advance(1);
report('SUSPENDED again after full new timeout', kernel.get('idle').status === 'SUSPENDED', kernel.get('idle').status);
kernel.delete('idle');

console.log('\n=== Scenario 5: same-name concurrent provisioning ===');
kernel.provision({ name: 'dup', template: 'node-dev' });
expectError('second provision with same name -> 409 NAME_CONFLICT', () =>
  kernel.provision({ name: 'dup', template: 'node-dev' }),
  'NAME_CONFLICT', (e) => (e.details as any).name === 'dup');
report('exactly one active instance named dup',
  kernel.query({}).filter((i) => i.name === 'dup' && i.status !== 'DELETED').length === 1,
  kernel.query({}).filter((i) => i.name === 'dup').map((i) => i.status));

console.log('\n=== Scenario 6: concurrency cap + FIFO queue ===');
kernel.provision({ name: 'q2', template: 'node-dev' });
kernel.provision({ name: 'q3', template: 'node-dev' });
report('cap=1: only first is PROVISIONING, rest PENDING',
  kernel.get('dup').status === 'PROVISIONING' && kernel.get('q2').status === 'PENDING' && kernel.get('q3').status === 'PENDING',
  { dup: kernel.get('dup').status, q2: kernel.get('q2').status, q3: kernel.get('q3').status });
clock.advance(1000);
report('FIFO: q2 starts after dup completes', kernel.get('q2').status === 'PROVISIONING' && kernel.get('q3').status === 'PENDING',
  { q2: kernel.get('q2').status, q3: kernel.get('q3').status });
clock.advance(2000);
report('queue drains in order', kernel.get('q2').status === 'SUSPENDED' ? false : kernel.get('q3').status === 'READY',
  { q2: kernel.get('q2').status, q3: kernel.get('q3').status });

console.log('\n=== Scenario 7: query filters + SQLite persistence ===');
report('query by template', kernel.query({ template: 'node-dev' }).length >= 4,
  kernel.query({ template: 'node-dev' }).map((i) => i.name));
report('query by status READY', kernel.query({ status: 'READY' }).every((i) => i.status === 'READY'),
  kernel.query({ status: 'READY' }).map((i) => i.name));
store.close();
const reopened = new InstanceStore(dbPath);
const persisted = reopened.getByName('life')!;
report('history persisted in SQLite across reopen',
  persisted.status === 'DELETED' && reopened.history(persisted.id).length === 6,
  reopened.history(persisted.id).map((h) => [h.runId, h.toStatus, h.reason]));
reopened.close();
rmSync(dir, { recursive: true, force: true });

console.log('\n========================================');
if (failures > 0) {
  console.log('ACCEPTANCE FAILED: ' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('ACCEPTANCE PASSED: all ' + step + ' checks green');
