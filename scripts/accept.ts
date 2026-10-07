/**
 * One-shot acceptance run: exercises every required scenario in a fixed
 * order against a real HTTP listener, printing request/response/verdict.
 * Exit 0 when all pass, non-zero naming the failed scenario otherwise.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BuildService } from '../src/service/buildService.ts';
import { buildApp } from '../src/http/app.ts';
import { FAILURE_MARKER } from '../src/fixtures/runner.ts';

const root = mkdtempSync(join(tmpdir(), 'bw-accept-'));
const write = (rel: string, content: string) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};
write('src/lib.ts', 'export const lib = 1;');
write('src/app.ts', 'import { lib } from "./lib";');
write('src/extra.ts', 'export const extra = 1;');
write('docs/readme.md', '# docs');

const config = loadConfig({ dbPath: join(root, 'accept.db'), workspaceRoot: root, buildDelayMs: 80, port: 0 });
const service = new BuildService(config);
const app = buildApp(service);
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

let failures = 0;
function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`> ${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
  console.log(`< ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, json };
}
function check(label: string, cond: boolean, detail: string): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}: ${detail}`);
  if (!cond) failures++;
}

const TARGETS = [
  { name: 'lib', paths: ['src/lib.ts'], deps: [] },
  { name: 'app', paths: ['src/app.ts'], deps: ['lib'] },
  { name: 'docs', paths: ['docs/readme.md'], deps: [] },
  { name: 'extra', paths: ['src/extra.ts'], deps: ['lib', 'docs'] },
];

step('0. register targets');
const reg = await call('POST', '/targets', { targets: TARGETS });
check('register', reg.status === 200 && reg.json.registered.length === 4, JSON.stringify(reg.json));

step('1. transitive closure + topological order');
const ev1 = await call('POST', '/events', { paths: ['src/lib.ts'] });
check('affected set', JSON.stringify(ev1.json.affected) === JSON.stringify(['app', 'extra', 'lib']), ev1.json.affected);
check('topo order', JSON.stringify(ev1.json.order) === JSON.stringify(['lib', 'app', 'extra']), ev1.json.order);
const run1 = await call('GET', `/runs/${ev1.json.runId}/wait`);
check('run1 all success', run1.json.records.every((r: any) => r.outcome === 'success'), JSON.stringify(run1.json.records.map((r: any) => [r.target, r.outcome])));

step('2. unchanged fingerprint -> skipped with reason');
const ev2 = await call('POST', '/events', { paths: ['src/lib.ts'] });
const run2 = await call('GET', `/runs/${ev2.json.runId}/wait`);
const allSkipped = run2.json.records.every((r: any) => r.outcome === 'skipped' && /fingerprint unchanged/.test(r.reason));
check('all skipped on fingerprint', allSkipped, JSON.stringify(run2.json.records.map((r: any) => [r.target, r.outcome, r.reason])));
const libInfo = await call('GET', '/targets/lib');
check('skip recorded in sqlite', libInfo.json.skips.length === 1, `skips=${libInfo.json.skips.length}`);

step('3. failed upstream blocks downstream');
write('src/lib.ts', FAILURE_MARKER);
const ev3 = await call('POST', '/events', { paths: ['src/lib.ts'] });
const run3 = await call('GET', `/runs/${ev3.json.runId}/wait`);
const by3 = new Map<string, any>(run3.json.records.map((r: any) => [r.target, r]));
check('lib failed', by3.get('lib')?.outcome === 'failed', by3.get('lib')?.reason);
check('app blocked by lib', by3.get('app')?.outcome === 'blocked' && /upstream lib/.test(by3.get('app')?.reason ?? ''), by3.get('app')?.reason);
check('extra blocked by lib', by3.get('extra')?.outcome === 'blocked' && /upstream lib/.test(by3.get('extra')?.reason ?? ''), by3.get('extra')?.reason);

step('4. change during build merges into one pending rebuild');
write('src/lib.ts', 'export const lib = 2;');
const ev4a = await call('POST', '/events', { paths: ['src/lib.ts'] });
await new Promise((r) => setTimeout(r, 30)); // lib is mid-build (buildDelayMs=80)
write('src/lib.ts', 'export const lib = 3;');
const ev4b = await call('POST', '/events', { paths: ['src/lib.ts'] });
const run4b = await call('GET', `/runs/${ev4b.json.runId}/wait`);
const mergedRec = run4b.json.records.find((r: any) => r.target === 'lib');
check('merged not double-queued', mergedRec?.outcome === 'skipped' && /merged: already building/.test(mergedRec?.reason ?? ''), mergedRec?.reason);
await service.waitForIdle();
const libAfter = await call('GET', '/targets/lib');
const successBuilds = libAfter.json.history.filter((h: any) => h.outcome === 'success').length;
check('exactly one merged rebuild round', successBuilds === 3, `success builds of lib=${successBuilds} (run1 + run4 + merged round)`);
check('final state success', libAfter.json.status.lastOutcome === 'success', libAfter.json.status.lastOutcome);

step('5. error categories are distinguishable');
const badInput = await call('POST', '/events', { paths: [] });
check('input error', badInput.status === 400 && badInput.json.error.code === 'INPUT_ERROR', JSON.stringify(badInput.json.error));
const noRun = await call('GET', '/runs/9999');
check('not found', noRun.status === 404 && noRun.json.error.code === 'NOT_FOUND', JSON.stringify(noRun.json.error));
const conflict = await call('POST', '/targets', { targets: TARGETS });
check('state conflict', conflict.status === 409 && conflict.json.error.code === 'STATE_CONFLICT', JSON.stringify(conflict.json.error));

await app.close();
service.close();

console.log(`\n${failures === 0 ? 'ACCEPTANCE PASSED' : `ACCEPTANCE FAILED: ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);