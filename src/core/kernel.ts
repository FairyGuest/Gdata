// Execution kernel: pure scheduling & accounting logic.
// No I/O, no HTTP. State mutations are reported through OpResult logs so the
// state adapter can persist them and callers can replay decisions by runId.
import { randomUUID } from 'node:crypto';
import type {
  EvictionRecord, LogEntry, NodeInfo, NamespaceInfo, OpResult,
  PlacementResult, QuotaDeficit, Workload,
} from '../contracts.ts';
import { KernelError } from '../contracts.ts';

export interface HistorySink {
  record(event: string, w: Workload, runId: string, reason: string): void;
}

function isPosNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export class Kernel {
  private nodes: NodeInfo[] = []; // registration order preserved
  private namespaces = new Map<string, NamespaceInfo>();
  private workloads = new Map<string, Workload>();
  private queue: string[] = [];   // FIFO of workload ids
  private nodeSeq = 0;
  private sink: HistorySink | null = null;

  setSink(sink: HistorySink): void { this.sink = sink; }

  private emit(runId: string, event: string, w: Workload, reason: string): void {
    this.sink?.record(event, w, runId, reason);
  }

  private run<T>(op: string, fn: (logs: LogEntry[], runId: string) => T): OpResult<T> {
    const runId = randomUUID();
    const logs: LogEntry[] = [];
    const log = (state: string, reason: string) => logs.push({ runId, op, state, reason });
    try {
      const value = fn(logs, runId);
      return { runId, ok: true, value, logs };
    } catch (e) {
      if (e instanceof KernelError) {
        log('error:' + e.kind, e.message);
        return { runId, ok: false, error: { kind: e.kind, message: e.message, details: e.details }, logs };
      }
      const msg = e instanceof Error ? e.message : String(e);
      log('error:INTERNAL', msg);
      return { runId, ok: false, error: { kind: 'INTERNAL', message: msg }, logs };
    }
  }

  // ---- registry ----

  addNode(input: { name: unknown; cpu: unknown; memMb: unknown }): OpResult<NodeInfo> {
    return this.run('addNode', (logs, runId) => {
      if (typeof input.name !== 'string' || input.name.length === 0) {
        throw new KernelError('VALIDATION', 'node name must be a non-empty string');
      }
      if (!isPosNum(input.cpu) || !isPosNum(input.memMb)) {
        throw new KernelError('VALIDATION', 'node cpu and memMb must be positive numbers');
      }
      const node: NodeInfo = {
        id: 'node-' + (++this.nodeSeq), name: input.name,
        cpu: input.cpu, memMb: input.memMb, order: this.nodeSeq,
      };
      this.nodes.push(node);
      logs.push({ runId, op: 'addNode', state: 'nodes=' + this.nodes.length, reason: 'registered at order ' + node.order });
      return node;
    });
  }

  addNamespace(input: { name: unknown; quotaCpu: unknown; quotaMemMb: unknown }): OpResult<NamespaceInfo> {
    return this.run('addNamespace', () => {
      if (typeof input.name !== 'string' || input.name.length === 0) {
        throw new KernelError('VALIDATION', 'namespace name must be a non-empty string');
      }
      if (!isPosNum(input.quotaCpu) || !isPosNum(input.quotaMemMb)) {
        throw new KernelError('VALIDATION', 'quotaCpu and quotaMemMb must be positive numbers');
      }
      if (this.namespaces.has(input.name)) {
        throw new KernelError('CONFLICT', 'namespace "' + input.name + '" already exists');
      }
      const ns: NamespaceInfo = { name: input.name, quotaCpu: input.quotaCpu, quotaMemMb: input.quotaMemMb };
      this.namespaces.set(ns.name, ns);
      return ns;
    });
  }

  // ---- placement ----

  placeWorkload(input: { id?: unknown; namespace: unknown; cpu: unknown; memMb: unknown }): OpResult<PlacementResult> {
    return this.run('placeWorkload', (logs, runId) => {
      const log = (state: string, reason: string) => logs.push({ runId, op: 'placeWorkload', state, reason });
      if (typeof input.namespace !== 'string' || !this.namespaces.has(input.namespace)) {
        throw new KernelError('NOT_FOUND', 'namespace "' + String(input.namespace) + '" does not exist');
      }
      if (!isPosNum(input.cpu) || !isPosNum(input.memMb)) {
        throw new KernelError('VALIDATION', 'workload cpu and memMb must be positive numbers');
      }
      const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : 'wl-' + randomUUID();
      if (this.workloads.has(id)) {
        throw new KernelError('CONFLICT', 'workload id "' + id + '" already exists');
      }
      const w: Workload = { id, namespace: input.namespace, cpu: input.cpu, memMb: input.memMb, nodeId: null, status: 'queued' };
      this.checkQuota(w); // quota gate first: throws QUOTA_EXCEEDED with deficit
      const node = this.firstFit(w);
      if (node) {
        w.nodeId = node.id; w.status = 'placed';
        this.workloads.set(id, w);
        log('node=' + node.id + ' wl=' + id, 'first-fit: first node in registration order with enough cpu+mem');
        this.emit(runId, 'placed', w, 'first-fit on ' + node.id);
        return { workloadId: id, outcome: 'placed', nodeId: node.id };
      }
      this.workloads.set(id, w);
      this.queue.push(id);
      log('queue=' + this.queue.join(','), 'no node fits both cpu and mem; enqueued FIFO at position ' + this.queue.length);
      this.emit(runId, 'queued', w, 'no node with sufficient capacity');
      return { workloadId: id, outcome: 'queued' };
    });
  }

  deleteWorkload(id: unknown): OpResult<{ released: boolean; drained: string[] }> {
    return this.run('deleteWorkload', (logs, runId) => {
      if (typeof id !== 'string' || !this.workloads.has(id)) {
        throw new KernelError('NOT_FOUND', 'workload "' + String(id) + '" does not exist');
      }
      const w = this.workloads.get(id)!;
      const wasPlaced = w.status === 'placed';
      this.release(w, runId, 'deleted');
      w.status = 'released';
      this.workloads.delete(id);
      logs.push({ runId, op: 'deleteWorkload', state: 'wl=' + id + ' node=' + String(w.nodeId), reason: 'released node capacity and namespace quota together' });
      const drained = this.drainQueue(logs, runId);
      return { released: wasPlaced, drained };
    });
  }

  deleteNamespace(name: unknown): OpResult<{ evicted: EvictionRecord[]; drained: string[] }> {
    return this.run('deleteNamespace', (logs, runId) => {
      if (typeof name !== 'string' || !this.namespaces.has(name)) {
        throw new KernelError('NOT_FOUND', 'namespace "' + String(name) + '" does not exist');
      }
      const evicted: EvictionRecord[] = [];
      for (const w of [...this.workloads.values()]) {
        if (w.namespace !== name) continue;
        evicted.push({ workloadId: w.id, nodeId: w.nodeId, cpu: w.cpu, memMb: w.memMb });
        if (w.status === 'placed') this.release(w, runId, 'evicted');
        else this.dequeue(w.id);
        w.status = 'evicted';
        this.workloads.delete(w.id);
        logs.push({ runId, op: 'deleteNamespace', state: 'evict wl=' + w.id + ' node=' + String(w.nodeId) + ' cpu=' + w.cpu + ' memMb=' + w.memMb, reason: 'cascade eviction from namespace "' + name + '"' });
        this.emit(runId, 'evicted', w, 'namespace ' + name + ' deleted');
      }
      this.namespaces.delete(name);
      const drained = this.drainQueue(logs, runId);
      return { evicted, drained };
    });
  }

  // ---- internals ----

  private checkQuota(w: Workload): void {
    const ns = this.namespaces.get(w.namespace)!;
    const used = this.nsUsed(w.namespace);
    const deficit: QuotaDeficit = {};
    if (used.cpu + w.cpu > ns.quotaCpu) deficit.cpu = used.cpu + w.cpu - ns.quotaCpu;
    if (used.memMb + w.memMb > ns.quotaMemMb) deficit.memMb = used.memMb + w.memMb - ns.quotaMemMb;
    if (deficit.cpu !== undefined || deficit.memMb !== undefined) {
      throw new KernelError('QUOTA_EXCEEDED',
        'namespace "' + w.namespace + '" quota exceeded', { deficit, used, quota: { cpu: ns.quotaCpu, memMb: ns.quotaMemMb } });
    }
  }

  private firstFit(w: Workload): NodeInfo | null {
    for (const n of this.nodes) { // registration order => deterministic
      const used = this.nodeUsed(n.id);
      if (used.cpu + w.cpu <= n.cpu && used.memMb + w.memMb <= n.memMb) return n;
    }
    return null;
  }

  private release(w: Workload, runId: string, reason: string): void {
    // one logical release covers both books: node capacity and namespace quota
    // are derived from the same workload set, so they cannot drift apart.
    this.emit(runId, 'released', w, reason);
  }

  private dequeue(id: string): void {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  // FIFO retry after any release. Head-of-line blocking keeps order strict:
  // if the head cannot be placed, later requests wait too.
  private drainQueue(logs: LogEntry[], runId: string): string[] {
    const drained: string[] = [];
    while (this.queue.length > 0) {
      const id = this.queue[0];
      const w = this.workloads.get(id);
      if (!w) { this.queue.shift(); continue; }
      if (!this.namespaces.has(w.namespace)) { this.queue.shift(); continue; }
      try {
        this.checkQuota(w);
      } catch {
        logs.push({ runId, op: 'drainQueue', state: 'head=' + id, reason: 'quota still insufficient; FIFO stops at head' });
        break;
      }
      const node = this.firstFit(w);
      if (!node) {
        logs.push({ runId, op: 'drainQueue', state: 'head=' + id, reason: 'no node fits head of queue; FIFO stops' });
        break;
      }
      this.queue.shift();
      w.nodeId = node.id; w.status = 'placed';
      drained.push(id);
      logs.push({ runId, op: 'drainQueue', state: 'wl=' + id + ' -> node=' + node.id, reason: 'capacity/quota released; queued request placed by first-fit' });
      this.emit(runId, 'placed', w, 'drained from queue onto ' + node.id);
    }
    return drained;
  }

  // ---- accounting / diagnostics ----

  nodeUsed(nodeId: string): { cpu: number; memMb: number } {
    let cpu = 0, memMb = 0;
    for (const w of this.workloads.values()) {
      if (w.status === 'placed' && w.nodeId === nodeId) { cpu += w.cpu; memMb += w.memMb; }
    }
    return { cpu, memMb };
  }

  nsUsed(ns: string): { cpu: number; memMb: number } {
    let cpu = 0, memMb = 0;
    for (const w of this.workloads.values()) {
      if (w.status === 'placed' && w.namespace === ns) { cpu += w.cpu; memMb += w.memMb; }
    }
    return { cpu, memMb };
  }

  diagnostics() {
    const nodes = this.nodes.map((n) => {
      const used = this.nodeUsed(n.id);
      return { ...n, used, remaining: { cpu: n.cpu - used.cpu, memMb: n.memMb - used.memMb } };
    });
    const namespaces = [...this.namespaces.values()].map((ns) => {
      const used = this.nsUsed(ns.name);
      return { ...ns, used, remaining: { cpu: ns.quotaCpu - used.cpu, memMb: ns.quotaMemMb - used.memMb } };
    });
    const queue = this.queue.map((id) => this.workloads.get(id)).filter((w): w is Workload => !!w);
    return { nodes, namespaces, queue };
  }

  // Conservation invariant: sum of placed allocations must equal sum of node
  // usage and sum of namespace usage, per dimension.
  conservation() {
    const placed = [...this.workloads.values()].filter((w) => w.status === 'placed');
    const alloc = placed.reduce((a, w) => ({ cpu: a.cpu + w.cpu, memMb: a.memMb + w.memMb }), { cpu: 0, memMb: 0 });
    const nodeSum = this.nodes.reduce((a, n) => {
      const u = this.nodeUsed(n.id); return { cpu: a.cpu + u.cpu, memMb: a.memMb + u.memMb };
    }, { cpu: 0, memMb: 0 });
    const nsSum = [...this.namespaces.keys()].reduce((a, name) => {
      const u = this.nsUsed(name); return { cpu: a.cpu + u.cpu, memMb: a.memMb + u.memMb };
    }, { cpu: 0, memMb: 0 });
    const balanced = alloc.cpu === nodeSum.cpu && alloc.memMb === nodeSum.memMb
      && alloc.cpu === nsSum.cpu && alloc.memMb === nsSum.memMb;
    return { allocations: alloc, nodeUsage: nodeSum, namespaceUsage: nsSum, balanced };
  }
}

