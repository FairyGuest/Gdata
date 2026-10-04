// One-shot acceptance drill. Runs every scenario from the spec in a fixed
// order against a real HTTP server, printing request / response / verdict at
// each step. Exit 0 iff every scenario passes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.ts';
import { generateStream, makeConflicting, makeReplayBatches, FIXTURE_SEED, ACTORS } from '../src/fixtures/generator.ts';
import { referenceProjection, stableStringify } from '../src/fixtures/reference.ts';

const RUN_ID = 'accept-' + process.pid;
const dir = mkdtempSync(join(tmpdir(), 'nft-indexer-accept-'));
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // a still-open db handle on exit is harmless for a throwaway temp dir
  }
});

let failures = 0;
let stepNo = 0;

function step(title: string): void {
  stepNo++;
  console.log('\n=== Step ' + stepNo + ': ' + title + ' ===');
}

function show(label: string, value: unknown): void {
  console.log('  ' + label + ': ' + JSON.stringify(value));
}

function judge(ok: boolean, why: string): void {
  console.log('  => ' + (ok ? 'PASS' : 'FAIL') + ' - ' + why);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log('runId=' + RUN_ID + ' seed=' + FIXTURE_SEED + ' dbDir=' + dir);

  const post = async (base: string, path: string, payload: unknown) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async (base: string, path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  const listen = async (app: ReturnType<typeof buildServer>) => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    return 'http://127.0.0.1:' + (typeof addr === 'object' && addr ? addr.port : 0);
  };

  // ---- Server A: sequential ingest + conflict scenarios -------------------
  const appA = buildServer({ dbPath: join(dir, 'a.db'), runId: RUN_ID });
  const baseA = await listen(appA);

  const stream = generateStream(40, FIXTURE_SEED);

  step('S1 sequential ingest of fixture stream (seq 1..30)');
  {
    let ok = true;
    for (const ev of stream.slice(0, 30)) {
      const r = await post(baseA, '/events', { event: ev });
      if (r.status !== 200 || r.body.appliedSeq !== ev.seq) {
        show('unexpected at seq ' + ev.seq, r);
        ok = false;
        break;
      }
    }
    const st = await get(baseA, '/diag/status');
    show('GET /diag/status', st.body);
    judge(ok && st.body.appliedSeq === 30, 'all 30 events applied in order, appliedSeq=30');
  }

  step('S2 concurrent duplicate submit of the same seq (commit-order arbitration)');
  {
    const ev = stream[30]!;
    show('POST /events (x2 concurrent)', ev);
    const [r1, r2] = await Promise.all([post(baseA, '/events', { event: ev }), post(baseA, '/events', { event: ev })]);
    show('response#1', r1);
    show('response#2', r2);
    const statuses = [r1.status, r2.status].sort().join(',');
    const loser = r1.status === 409 ? r1 : r2;
    const ref = referenceProjection(stream.slice(0, 31));
    const stats = (await get(baseA, '/diag/stats')).body;
    show('GET /diag/stats', stats);
    judge(
      statuses === '200,409' && loser.body.error?.reason === 'duplicate_event' && stats.volume === ref.volume && stats.floor === ref.floor,
      'exactly one 200 and one 409 duplicate_event; volume/floor counted once',
    );
  }

  step('S3 same seq, different content -> 409 duplicate_event, no overwrite');
  {
    const applied = stream[30]!;
    const conflict = makeConflicting(applied);
    show('POST /events (conflicting)', conflict);
    const r = await post(baseA, '/events', { event: conflict });
    show('response', r);
    const owner = (await get(baseA, '/diag/owner/' + applied.tokenId)).body;
    show('GET /diag/owner/' + applied.tokenId, owner);
    judge(
      r.status === 409 && r.body.error?.reason === 'duplicate_event' && owner.owner === applied.to,
      'conflicting resubmission rejected; stored event untouched',
    );
  }

  step('S4 seq jump -> 409 event_gap, projection frozen');
  {
    const gapEv = { ...stream[35]!, seq: 40 };
    show('POST /events (gap seq=40 while appliedSeq=31)', gapEv);
    const r = await post(baseA, '/events', { event: gapEv });
    show('response', r);
    const st = (await get(baseA, '/diag/status')).body;
    show('GET /diag/status', st);
    judge(r.status === 409 && r.body.error?.reason === 'event_gap' && st.appliedSeq === 31, 'gap rejected, appliedSeq stays 31');
  }

  step('S5 invalid transfer (from != owner) -> 409 invalid_transition, then legal event applies');
  {
    const next = stream[31]!;
    const bad = { ...next, from: ACTORS[7] === next.from ? ACTORS[6] : ACTORS[7] };
    show('POST /events (bad from)', bad);
    const rBad = await post(baseA, '/events', { event: bad });
    show('response', rBad);
    const stMid = (await get(baseA, '/diag/status')).body;
    show('GET /diag/status after rejection', stMid);
    const rGood = await post(baseA, '/events', { event: next });
    show('POST /events (legal)', { status: rGood.status, body: rGood.body });
    const stEnd = (await get(baseA, '/diag/status')).body;
    judge(
      rBad.status === 409 &&
        rBad.body.error?.reason === 'invalid_transition' &&
        stMid.appliedSeq === 31 &&
        rGood.status === 200 &&
        stEnd.appliedSeq === 32,
      'invalid transfer rejected without advancing; subsequent legal event applied',
    );
  }

  step('S6 malformed input -> 422 invalid_input');
  {
    const r = await post(baseA, '/events', { event: { seq: -1, type: 'mint' } });
    show('response', r);
    judge(r.status === 422 && r.body.error?.reason === 'invalid_input', 'bad input classified as 422 invalid_input');
  }

  step('S7 oversized batch -> 503 resource_exhausted');
  {
    const appSmall = buildServer({ dbPath: ':memory:', runId: RUN_ID, maxBatchSize: 2 });
    const base = await listen(appSmall);
    const r = await post(base, '/events/batch', { events: stream.slice(0, 3) });
    show('response', r);
    judge(r.status === 503 && r.body.error?.reason === 'resource_exhausted', 'oversized batch classified as 503 resource_exhausted');
    await appSmall.close();
    appSmall.db.close();
  }

  await appA.close();
  appA.db.close();

  // ---- Server B: out-of-order + duplicated replay, then rebuild ------------
  step('S8 replay out-of-order/duplicated batches; final projection equals reference oracle');
  const appB = buildServer({ dbPath: join(dir, 'b.db'), runId: RUN_ID });
  const baseB = await listen(appB);
  {
    const batches = makeReplayBatches(stream, 6);
    let dup = 0;
    let gap = 0;
    for (let round = 0; round < 6; round++) {
      for (const batch of batches) {
        const r = await post(baseB, '/events/batch', { events: batch });
        for (const item of r.body.results) {
          if (!item.ok && item.reason === 'duplicate_event') dup++;
          if (!item.ok && item.reason === 'event_gap') gap++;
        }
      }
      const st = await get(baseB, '/diag/status');
      if (st.body.appliedSeq === stream.length) break;
    }
    show('replay verdicts', { batches: batches.length, duplicateRejections: dup, gapRejections: gap });
    const proj = (await get(baseB, '/diag/projection')).body;
    const ref = referenceProjection(stream);
    const same =
      proj.appliedSeq === ref.appliedSeq &&
      stableStringify(proj.owners) === stableStringify(ref.owners) &&
      proj.stats.volume === ref.volume &&
      proj.stats.floor === ref.floor &&
      stableStringify(proj.lastSale) === stableStringify(ref.lastSale);
    show('appliedSeq', proj.appliedSeq);
    show('stats', proj.stats);
    judge(same && dup > 0 && gap > 0, 'replay converged to reference projection; dup/gap rejections were exercised');
  }

  step('S9 rebuild(14) and rebuild(33) match the reference oracle bitwise');
  {
    let ok = true;
    for (const h of [14, 33]) {
      const rb = await post(baseB, '/rebuild', { toSeq: h });
      const proj = (await get(baseB, '/diag/projection')).body;
      const ref = referenceProjection(stream, h);
      const same =
        rb.status === 200 &&
        proj.appliedSeq === h &&
        stableStringify(proj.owners) === stableStringify(ref.owners) &&
        proj.stats.volume === ref.volume &&
        proj.stats.floor === ref.floor &&
        proj.stats.salesCount === ref.salesCount &&
        stableStringify(proj.lastSale) === stableStringify(ref.lastSale);
      show('rebuild(' + h + ')', { status: rb.status, appliedSeq: proj.appliedSeq, match: same });
      if (!same) ok = false;
    }
    judge(ok, 'both sampled heights bitwise identical to reference');
  }

  step('S10 rebuild(full) reproduces the incremental projection bitwise');
  {
    await post(baseB, '/rebuild', { toSeq: 40 });
    const before = (await get(baseB, '/diag/projection')).body;
    await post(baseB, '/rebuild', { toSeq: 40 });
    const after = (await get(baseB, '/diag/projection')).body;
    const ref = referenceProjection(stream);
    const ok =
      stableStringify(after) === stableStringify(before) &&
      after.appliedSeq === 40 &&
      after.stats.volume === ref.volume;
    show('incremental vs rebuild(40)', { identical: stableStringify(after) === stableStringify(before) });
    judge(ok, 'incremental and rebuild paths are the same pure function of the log');
  }

  step('S11 diagnostics: rejections carry runId/seq/reason');
  {
    const rej = (await get(baseB, '/diag/rejections')).body;
    const sample = rej.rejections.slice(0, 3);
    show('sample rejections', sample);
    const ok = rej.rejections.length > 0 && rej.rejections.every((r: { runId: string; reason: string }) => r.runId === RUN_ID && r.reason.length > 0);
    judge(ok, rej.rejections.length + ' rejections logged with runId=' + RUN_ID);
  }

  await appB.close();
  appB.db.close();

  console.log('\n========================================');
  if (failures === 0) {
    console.log('ACCEPT: all ' + stepNo + ' scenarios passed');
  } else {
    console.log('ACCEPT: ' + failures + ' scenario(s) FAILED out of ' + stepNo);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ACCEPT: fatal error', err);
  process.exitCode = 1;
});
