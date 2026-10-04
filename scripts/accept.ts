/**
 * One-shot acceptance script: boots the vault on a temp DB with a VirtualClock,
 * then exercises every required scenario in a fixed order over real HTTP.
 * Exit 0 when all scenarios pass; non-zero (naming the failed scenario) otherwise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock } from '../src/clock.js';
import { Aes256GcmCipher } from '../src/crypto.js';
import { VaultKernel } from '../src/kernel.js';
import { buildServer } from '../src/server.js';
import { VaultStore } from '../src/store.js';

const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const GRACE_MS = 5_000;
const RUN_ID = 'accept-' + Date.now();

let failures = 0;
let currentScenario = 'setup';

function judge(ok: boolean, why: string): void {
  console.log('  JUDGE: ' + (ok ? 'PASS' : 'FAIL') + ' - ' + why);
  if (!ok) failures++;
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', 'x-run-id': RUN_ID },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  console.log('  REQ : ' + method + ' ' + path + (body !== undefined ? ' ' + JSON.stringify(body) : ''));
  const res = await fetch(base + path, init);
  const json = (await res.json()) as Record<string, unknown>;
  console.log('  RESP: ' + res.status + ' ' + JSON.stringify(json));
  return { status: res.status, json };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vault-accept-'));
  const clock = new VirtualClock(1_700_000_000_000);
  const store = new VaultStore(join(dir, 'accept.db'));
  const cipher = new Aes256GcmCipher(Buffer.from(KEY_HEX, 'hex'), 'accept-key');
  const kernel = new VaultKernel(store, cipher, clock, {
    gracePeriodMs: GRACE_MS,
    maxValueBytes: 1024,
    maxVersionsPerSecret: 100,
  });
  const app = buildServer({ kernel, clock, startedAt: clock.now() });
  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = addr.includes('://') ? addr : 'http://127.0.0.1:' + addr;
  console.log('runId=' + RUN_ID + ' base=' + base + ' graceMs=' + GRACE_MS);

  try {
    // S1: health / diagnostics
    currentScenario = 'S1 health';
    console.log('\n[S1] diagnostics /health');
    let r = await call(base, 'GET', '/health');
    judge(r.status === 200 && r.json.status === 'ok', 'service healthy, stats present: ' + JSON.stringify(r.json.stats));

    // S2: multi-version write & read
    currentScenario = 'S2 multi-version write/read';
    console.log('\n[S2] multi-version write + read');
    r = await call(base, 'PUT', '/secrets/db-password', { value: 's3cret-v1' });
    judge(r.status === 200 && r.json.version === 1, 'write #1 -> version 1');
    r = await call(base, 'PUT', '/secrets/db-password', { value: 's3cret-v2' });
    judge(r.status === 200 && r.json.version === 2, 'write #2 -> version 2');
    r = await call(base, 'PUT', '/secrets/db-password', { value: 's3cret-v3' });
    judge(r.status === 200 && r.json.version === 3, 'write #3 -> version 3');
    r = await call(base, 'GET', '/secrets/db-password');
    judge(r.json.value === 's3cret-v3', 'latest read returns v3 value');
    r = await call(base, 'GET', '/secrets/db-password?version=1');
    judge(r.json.value === 's3cret-v1', 'old version 1 still readable');
    r = await call(base, 'GET', '/secrets/db-password?version=2');
    judge(r.json.value === 's3cret-v2', 'old version 2 still readable');

    // S3: rotation grace period, expiring exactly at boundary
    currentScenario = 'S3 rotation grace boundary';
    console.log('\n[S3] rotation + grace period boundary');
    r = await call(base, 'POST', '/secrets/db-password/rotate', {});
    const graceUntil = Number(r.json.graceUntil);
    judge(r.status === 200 && r.json.currentVersion === 3 && r.json.expiredVersions === 2,
      'rotate retires v1,v2 with graceUntil=' + graceUntil);
    r = await call(base, 'GET', '/secrets/db-password?version=1');
    judge(r.status === 200 && r.json.value === 's3cret-v1', 'v1 readable during grace');
    const now1 = clock.now();
    await call(base, 'POST', '/diag/clock/advance', { ms: graceUntil - 1 - now1 });
    r = await call(base, 'GET', '/secrets/db-password?version=1');
    judge(r.status === 200, 'v1 readable 1ms before expiry (now=' + clock.now() + ')');
    await call(base, 'POST', '/diag/clock/advance', { ms: 1 });
    r = await call(base, 'GET', '/secrets/db-password?version=1');
    judge(r.status === 410 && (r.json.error as Record<string, unknown>)?.code === 'VERSION_EXPIRED',
      'v1 expired exactly at graceUntil -> 410 VERSION_EXPIRED');
    r = await call(base, 'GET', '/secrets/db-password?version=3');
    judge(r.status === 200 && r.json.value === 's3cret-v3', 'current version unaffected by expiry');

    // S4: audit log integrity
    currentScenario = 'S4 audit integrity';
    console.log('\n[S4] audit log integrity');
    r = await call(base, 'GET', '/audit/verify');
    judge(r.status === 200 && r.json.ok === true, 'hash chain verifies over ' + r.json.entries + ' entries');
    r = await call(base, 'GET', '/audit?name=db-password');
    const entries = r.json.entries as Array<Record<string, unknown>>;
    judge(
      Array.isArray(entries) && entries.length > 0 && entries.every((e) => e.runId === RUN_ID && typeof e.reason === 'string' && (e.reason as string).length > 0),
      'all entries carry runId=' + RUN_ID + ' and a judgement reason',
    );
    judge(entries.some((e) => e.result === 'ERROR'), 'failed ops are audited too');

    // S5: encryption roundtrip + at-rest ciphertext
    currentScenario = 'S5 encrypt/decrypt roundtrip';
    console.log('\n[S5] encryption roundtrip');
    await call(base, 'PUT', '/secrets/roundtrip', { value: 'roundtrip-plain' });
    r = await call(base, 'GET', '/secrets/roundtrip');
    judge(r.json.value === 'roundtrip-plain', 'decrypt(encrypt(v)) === v');
    const row = store.getVersion('roundtrip', 1);
    judge(row !== undefined && row.ciphertext.toString('utf8') !== 'roundtrip-plain',
      'at-rest bytes are ciphertext (keyId=' + (row?.key_id ?? '?') + ')');

    // S6: error categories distinguishable
    currentScenario = 'S6 error categories';
    console.log('\n[S6] error category semantics');
    r = await call(base, 'PUT', '/secrets/bad%20name', { value: 'x' });
    let err = r.json.error as Record<string, unknown>;
    judge(r.status === 400 && err.code === 'VALIDATION' && err.category === 'INPUT', 'invalid name -> 400 INPUT/VALIDATION');
    r = await call(base, 'GET', '/secrets/never-wrote');
    err = r.json.error as Record<string, unknown>;
    judge(r.status === 404 && err.code === 'NOT_FOUND' && err.category === 'STATE', 'missing secret -> 404 STATE/NOT_FOUND');
    r = await call(base, 'PUT', '/secrets/roundtrip', { value: 'x'.repeat(2048) });
    err = r.json.error as Record<string, unknown>;
    judge(r.status === 413 && err.code === 'RESOURCE_EXHAUSTED' && err.category === 'RESOURCE', 'oversized value -> 413 RESOURCE/RESOURCE_EXHAUSTED');
  } catch (e) {
    console.error('\nFATAL in scenario ' + currentScenario + ': ' + (e instanceof Error ? e.message : String(e)));
    failures++;
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n==== ACCEPTANCE ' + (failures === 0 ? 'PASSED' : 'FAILED (' + failures + ' judge(s), last scenario: ' + currentScenario + ')') + ' ====');
  process.exit(failures === 0 ? 0 : 1);
}

main();
