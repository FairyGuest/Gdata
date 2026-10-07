// Kernel unit tests: assert concrete outcomes and error categories,
// with expected values computed independently of the kernel implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kernel } from '../src/core/kernel.ts';

function makeKernel(): Kernel {
  const k = new Kernel();
  k.addNode({ name: 'n1', cpu: 4, memMb: 8192 });
  k.addNode({ name: 'n2', cpu: 8, memMb: 16384 });
  k.addNamespace({ name: 'team-a', quotaCpu: 8, quotaMemMb: 16384 });
  return k;
}

test('first-fit is deterministic: same input, same decision', () => {
  for (let round = 0; round < 2; round++) {
    const k = makeKernel();
    const r1 = k.placeWorkload({ id: 'w1', namespace: 'team-a', cpu: 2, memMb: 1024 });
    const r2 = k.placeWorkload({ id: 'w2', namespace: 'team-a', cpu: 2, memMb: 1024 });
    assert.equal(r1.ok, true);
    assert.equal(r1.value?.outcome, 'placed');
    assert.equal(r1.value?.nodeId, 'node-1'); // first node in registration order that fits
    assert.equal(r2.value?.nodeId, 'node-1'); // 2+2=4cpu exactly fills node-1; mem 2048<=8192
  }
});

test('first-fit skips full nodes in registration order', () => {
  const k = makeKernel();
  k.placeWorkload({ id: 'big', namespace: 'team-a', cpu: 4, memMb: 8192 }); // fills node-1 exactly
  const r = k.placeWorkload({ id: 'next', namespace: 'team-a', cpu: 1, memMb: 1024 });
  assert.equal(r.value?.nodeId, 'node-2');
});

test('quota exceeded rejects with per-dimension deficit', () => {
  const k = makeKernel();
  k.placeWorkload({ id: 'w1', namespace: 'team-a', cpu: 6, memMb: 10000 });
  const r = k.placeWorkload({ id: 'w2', namespace: 'team-a', cpu: 4, memMb: 7000 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'QUOTA_EXCEEDED');
  const d = r.error?.details as { deficit: { cpu: number; memMb: number } };
  assert.deepEqual(d.deficit, { cpu: 2, memMb: 616 }); // 6+4-8=2 cpu; 10000+7000-16384=616 MB
});

test('queued workload drains FIFO after release', () => {
  const k = new Kernel();
  k.addNode({ name: 'n1', cpu: 4, memMb: 4096 });
  k.addNamespace({ name: 'ns', quotaCpu: 100, quotaMemMb: 100000 });
  k.placeWorkload({ id: 'a', namespace: 'ns', cpu: 4, memMb: 4096 }); // fills node
  const q1 = k.placeWorkload({ id: 'b', namespace: 'ns', cpu: 2, memMb: 1024 });
  const q2 = k.placeWorkload({ id: 'c', namespace: 'ns', cpu: 1, memMb: 1024 });
  assert.equal(q1.value?.outcome, 'queued');
  assert.equal(q2.value?.outcome, 'queued');
  const del = k.deleteWorkload('a');
  assert.equal(del.ok, true);
  // FIFO with head-of-line blocking: b fits (2cpu), then c fits (1cpu) -> both drain
  assert.deepEqual(del.value?.drained, ['b', 'c']);
  const d = k.diagnostics();
  assert.equal(d.queue.length, 0);
});

test('head-of-line blocking keeps FIFO order when head does not fit', () => {
  const k = new Kernel();
  k.addNode({ name: 'n1', cpu: 4, memMb: 4096 });
  k.addNamespace({ name: 'ns', quotaCpu: 100, quotaMemMb: 100000 });
  k.placeWorkload({ id: 'a', namespace: 'ns', cpu: 4, memMb: 4096 });
  k.placeWorkload({ id: 'big', namespace: 'ns', cpu: 3, memMb: 1024 }); // queued head
  k.placeWorkload({ id: 'small', namespace: 'ns', cpu: 1, memMb: 1024 }); // queued behind
  const del = k.deleteWorkload('a'); // frees 4cpu: big(3) fits, then small(1) fits
  assert.deepEqual(del.value?.drained, ['big', 'small']);
});

test('namespace deletion cascades evictions and frees capacity', () => {
  const k = makeKernel();
  k.placeWorkload({ id: 'w1', namespace: 'team-a', cpu: 2, memMb: 1024 });
  k.placeWorkload({ id: 'w2', namespace: 'team-a', cpu: 2, memMb: 1024 });
  const r = k.deleteNamespace('team-a');
  assert.equal(r.ok, true);
  assert.equal(r.value?.evicted.length, 2);
  assert.deepEqual(r.value?.evicted.map((e) => e.workloadId).sort(), ['w1', 'w2']);
  const d = k.diagnostics();
  assert.deepEqual(d.nodes[0].used, { cpu: 0, memMb: 0 }); // capacity fully returned
  assert.equal(d.namespaces.length, 0);
  // eviction is traceable: one log line per evicted workload
  const evictLogs = r.logs.filter((l) => l.state.startsWith('evict wl='));
  assert.equal(evictLogs.length, 2);
  assert.ok(evictLogs.every((l) => l.runId === r.runId));
});

test('duplicate namespace returns CONFLICT', () => {
  const k = makeKernel();
  const r = k.addNamespace({ name: 'team-a', quotaCpu: 1, quotaMemMb: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'CONFLICT');
});

test('placement into missing namespace returns NOT_FOUND', () => {
  const k = makeKernel();
  const r = k.placeWorkload({ namespace: 'ghost', cpu: 1, memMb: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.kind, 'NOT_FOUND');
});

test('invalid input returns VALIDATION', () => {
  const k = makeKernel();
  assert.equal(k.addNode({ name: '', cpu: 1, memMb: 1 }).error?.kind, 'VALIDATION');
  assert.equal(k.addNode({ name: 'x', cpu: -1, memMb: 1 }).error?.kind, 'VALIDATION');
  assert.equal(k.placeWorkload({ namespace: 'team-a', cpu: 0, memMb: 1 }).error?.kind, 'VALIDATION');
});

test('conservation: sum of allocations equals node usage equals namespace usage', () => {
  const k = makeKernel();
  k.addNamespace({ name: 'team-b', quotaCpu: 4, quotaMemMb: 4096 });
  k.placeWorkload({ id: 'a', namespace: 'team-a', cpu: 2, memMb: 2048 });
  k.placeWorkload({ id: 'b', namespace: 'team-a', cpu: 1, memMb: 1024 });
  k.placeWorkload({ id: 'c', namespace: 'team-b', cpu: 3, memMb: 1024 });
  k.deleteWorkload('b');
  const c = k.conservation();
  assert.equal(c.balanced, true);
  // independently computed expectation: a(2,2048) + c(3,1024)
  assert.deepEqual(c.allocations, { cpu: 5, memMb: 3072 });
  assert.deepEqual(c.nodeUsage, { cpu: 5, memMb: 3072 });
  assert.deepEqual(c.namespaceUsage, { cpu: 5, memMb: 3072 });
});

test('every op returns a runId and reasoned logs for replay', () => {
  const k = makeKernel();
  const r = k.placeWorkload({ id: 'w1', namespace: 'team-a', cpu: 1, memMb: 1 });
  assert.ok(r.runId.length > 0);
  assert.ok(r.logs.length > 0);
  assert.ok(r.logs.every((l) => l.runId === r.runId && l.reason.length > 0));
});

