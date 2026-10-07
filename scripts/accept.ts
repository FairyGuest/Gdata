// One-shot acceptance script: exercises every required scenario in a fixed
// order against a fresh in-process server, printing request, response and
// verdict per step. Exit 0 iff all steps pass.
//
// Fixture topology (all numbers chosen so expectations are computable by hand):
//   node-1: 4 cpu / 8192 MB   node-2: 4 cpu / 6144 MB   (registration order)
//   team-a quota: 10 cpu / 20480 MB  (quota > cluster capacity, so both
//   quota-exhaustion and capacity-exhaustion paths are reachable)
import { buildServer } from '../src/server.ts';

const PORT = 3199;
const BASE = 'http://127.0.0.1:' + PORT;
let failures = 0;
let step = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

function check(name: string, cond: boolean, detail: string) {
  step++;
  const verdict = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log('[' + verdict + '] step ' + step + ': ' + name + ' -- ' + detail);
}

async function scenario(name: string, method: string, path: string, body: unknown, expectStatus: number, extra?: (json: never) => [boolean, string]) {
  const r = await call(method, path, body);
  console.log('  > ' + method + ' ' + path + (body !== undefined ? ' ' + JSON.stringify(body) : ''));
  console.log('  < ' + r.status + ' ' + JSON.stringify(r.json));
  let ok = r.status === expectStatus;
  let detail = 'expected HTTP ' + expectStatus + ', got ' + r.status;
  if (ok && extra) {
    const [eok, edetail] = extra(r.json as never);
    ok = eok; detail = edetail;
  }
  check(name, ok, detail);
  return r.json as never;
}

const { app } = buildServer({ host: '127.0.0.1', port: PORT, dbPath: ':memory:' });
await app.listen({ host: '127.0.0.1', port: PORT });
console.log('acceptance run against ' + BASE + ' (in-memory sqlite)');

// 1. register nodes (order matters for first-fit determinism)
await scenario('register node n1', 'POST', '/nodes', { name: 'n1', cpu: 4, memMb: 8192 }, 201);
await scenario('register node n2', 'POST', '/nodes', { name: 'n2', cpu: 4, memMb: 6144 }, 201);

// 2. namespace + duplicate conflict
await scenario('create namespace team-a', 'POST', '/namespaces', { name: 'team-a', quotaCpu: 10, quotaMemMb: 20480 }, 201);
await scenario('duplicate namespace -> 409 CONFLICT', 'POST', '/namespaces', { name: 'team-a', quotaCpu: 1, quotaMemMb: 1 }, 409,
  (j: { error: { kind: string } }) => [j.error.kind === 'CONFLICT', 'error.kind=' + j.error.kind]);

// 3. missing namespace / invalid input
await scenario('place into missing namespace -> 404 NOT_FOUND', 'POST', '/workloads', { namespace: 'ghost', cpu: 1, memMb: 1 }, 404,
  (j: { error: { kind: string } }) => [j.error.kind === 'NOT_FOUND', 'error.kind=' + j.error.kind]);
await scenario('invalid workload -> 400 VALIDATION', 'POST', '/workloads', { namespace: 'team-a', cpu: -1, memMb: 10 }, 400,
  (j: { error: { kind: string } }) => [j.error.kind === 'VALIDATION', 'error.kind=' + j.error.kind]);

// 4. first-fit determinism: w1,w2 fill node-1 cpu; w3 spills to node-2
await scenario('w1 -> node-1', 'POST', '/workloads', { id: 'w1', namespace: 'team-a', cpu: 2, memMb: 2048 }, 201,
  (j: { data: { nodeId: string } }) => [j.data.nodeId === 'node-1', 'nodeId=' + j.data.nodeId]);
await scenario('w2 -> node-1 (exactly fills cpu)', 'POST', '/workloads', { id: 'w2', namespace: 'team-a', cpu: 2, memMb: 2048 }, 201,
  (j: { data: { nodeId: string } }) => [j.data.nodeId === 'node-1', 'nodeId=' + j.data.nodeId]);
await scenario('w3 -> node-2 (node-1 cpu full)', 'POST', '/workloads', { id: 'w3', namespace: 'team-a', cpu: 1, memMb: 1024 }, 201,
  (j: { data: { nodeId: string } }) => [j.data.nodeId === 'node-2', 'nodeId=' + j.data.nodeId]);

// 5. quota gate: used 5cpu/5120MB; request 6cpu/16000MB -> deficit cpu 1, mem 640
await scenario('quota exceeded -> 422 with per-dimension deficit', 'POST', '/workloads', { id: 'w4', namespace: 'team-a', cpu: 6, memMb: 16000 }, 422,
  (j: { error: { kind: string; details: { deficit: { cpu: number; memMb: number } } } }) => {
    const d = j.error.details.deficit;
    return [j.error.kind === 'QUOTA_EXCEEDED' && d.cpu === 1 && d.memMb === 640,
      'kind=' + j.error.kind + ' deficit=' + JSON.stringify(d)];
  });

// 6. fill node-2 cpu, then quota rejects (not queued)
await scenario('w5 -> node-2 (fills its cpu)', 'POST', '/workloads', { id: 'w5', namespace: 'team-a', cpu: 3, memMb: 4096 }, 201,
  (j: { data: { nodeId: string } }) => [j.data.nodeId === 'node-2', 'nodeId=' + j.data.nodeId]);
await scenario('quota reject (8+3>10 cpu) -> 422', 'POST', '/workloads', { id: 'wX', namespace: 'team-a', cpu: 3, memMb: 2000 }, 422,
  (j: { error: { kind: string } }) => [j.error.kind === 'QUOTA_EXCEEDED', 'error.kind=' + j.error.kind]);

// 7. capacity exhausted everywhere -> FIFO queue (quota still has 2cpu/11264MB headroom)
await scenario('w6 queued (no node has free cpu)', 'POST', '/workloads', { id: 'w6', namespace: 'team-a', cpu: 1, memMb: 512 }, 201,
  (j: { data: { outcome: string } }) => [j.data.outcome === 'queued', 'outcome=' + j.data.outcome]);
await scenario('w7 queued behind w6', 'POST', '/workloads', { id: 'w7', namespace: 'team-a', cpu: 1, memMb: 512 }, 201,
  (j: { data: { outcome: string } }) => [j.data.outcome === 'queued', 'outcome=' + j.data.outcome]);
await scenario('queue is [w6, w7] in FIFO order', 'GET', '/diag/state', undefined, 200,
  (j: { queue: { id: string }[] }) => [JSON.stringify(j.queue.map((q) => q.id)) === JSON.stringify(['w6', 'w7']),
    'queue=' + JSON.stringify(j.queue.map((q) => q.id))]);

// 8. release w2 -> frees 2cpu/2048MB on node-1 -> both queued requests drain FIFO onto node-1
await scenario('delete w2 drains queue FIFO [w6, w7]', 'DELETE', '/workloads/w2', undefined, 200,
  (j: { data: { drained: string[] } }) => [JSON.stringify(j.data.drained) === JSON.stringify(['w6', 'w7']),
    'drained=' + JSON.stringify(j.data.drained)]);
await scenario('node-1 now hosts w1+w6+w7 = 4cpu/3072MB', 'GET', '/diag/state', undefined, 200,
  (j: { nodes: { id: string; used: { cpu: number; memMb: number } }[] }) => {
    const n1 = j.nodes.find((n) => n.id === 'node-1');
    return [n1 !== undefined && n1.used.cpu === 4 && n1.used.memMb === 3072, 'node-1 used=' + JSON.stringify(n1?.used)];
  });

// 9. conservation: placed = w1(2,2048)+w3(1,1024)+w5(3,4096)+w6(1,512)+w7(1,512) = 8cpu/8192MB
await scenario('conservation: allocations == node usage == namespace usage', 'GET', '/diag/conservation', undefined, 200,
  (j: { balanced: boolean; allocations: { cpu: number; memMb: number } }) =>
    [j.balanced && j.allocations.cpu === 8 && j.allocations.memMb === 8192,
      'balanced=' + j.balanced + ' allocations=' + JSON.stringify(j.allocations)]);

// 10. cascade eviction of all 5 workloads
await scenario('delete namespace team-a cascades 5 evictions', 'DELETE', '/namespaces/team-a', undefined, 200,
  (j: { data: { evicted: { workloadId: string }[] } }) => {
    const ids = j.data.evicted.map((e) => e.workloadId).sort();
    return [JSON.stringify(ids) === JSON.stringify(['w1', 'w3', 'w5', 'w6', 'w7']), 'evicted=' + JSON.stringify(ids)];
  });
await scenario('all capacity and quota freed after cascade', 'GET', '/diag/conservation', undefined, 200,
  (j: { balanced: boolean; allocations: { cpu: number; memMb: number } }) =>
    [j.balanced && j.allocations.cpu === 0 && j.allocations.memMb === 0,
      'balanced=' + j.balanced + ' allocations=' + JSON.stringify(j.allocations)]);

// 11. audit trail: 5 evicted events recorded for team-a
await scenario('history for team-a contains 5 evictions', 'GET', '/diag/history?namespace=team-a', undefined, 200,
  (j: { event: string }[]) => {
    const ev = j.filter((h) => h.event === 'evicted').length;
    return [ev === 5, 'evicted events=' + ev + ' total rows=' + j.length];
  });

await app.close(); await new Promise((r) => setTimeout(r, 200));
console.log(failures === 0 ? 'ALL ' + step + ' CHECKS PASSED' : failures + ' of ' + step + ' checks FAILED');
process.exit(failures === 0 ? 0 : 1);

