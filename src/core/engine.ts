import {
  NamespaceInfo,
  NodeInfo,
  QuotaShortfall,
  Resources,
  ServiceError,
  Workload,
} from "../domain/types.js";

export interface PlacementDecision {
  workloadId: string;
  outcome: "placed" | "queued";
  nodeId: string | null;
  reason: string;
}

export interface EvictionRecord {
  workloadId: string;
  namespace: string;
  nodeId: string | null;
  released: Resources;
  reason: string;
}

export interface EngineEvent {
  runId: string;
  seq: number;
  action: string;
  detail: Record<string, unknown>;
}

export interface EngineOptions {
  runId?: string;
  onEvent?: (e: EngineEvent) => void;
}

function fits(cap: Resources, used: Resources, req: Resources): boolean {
  return used.cpu + req.cpu <= cap.cpu && used.memoryMb + req.memoryMb <= cap.memoryMb;
}

function add(a: Resources, b: Resources): Resources {
  return { cpu: a.cpu + b.cpu, memoryMb: a.memoryMb + b.memoryMb };
}

function sub(a: Resources, b: Resources): Resources {
  return { cpu: a.cpu - b.cpu, memoryMb: a.memoryMb - b.memoryMb };
}

/**
 * Execution kernel. Owns nodes, namespaces, workloads and the FIFO wait queue.
 * First-fit placement by node registration order; quota checked before capacity.
 * Every mutation emits an EngineEvent so runs can be replayed/audited.
 */
export class Engine {
  private nodes: NodeInfo[] = [];
  private namespaces = new Map<string, NamespaceInfo>();
  private workloads = new Map<string, Workload>();
  private queue: string[] = []; // workload ids, FIFO
  private seq = 0;
  private eventSeq = 0;
  readonly runId: string;
  private onEvent?: (e: EngineEvent) => void;

  constructor(opts: EngineOptions = {}) {
    this.runId = opts.runId ?? `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.onEvent = opts.onEvent;
  }

  private emit(action: string, detail: Record<string, unknown>): void {
    this.onEvent?.({ runId: this.runId, seq: ++this.eventSeq, action, detail });
  }

  registerNode(id: string, capacity: Resources): NodeInfo {
    if (this.nodes.some((n) => n.id === id)) {
      throw new ServiceError("CONFLICT", `node '${id}' already registered`, { id });
    }
    const node: NodeInfo = { id, capacity, used: { cpu: 0, memoryMb: 0 }, seq: this.nodes.length };
    this.nodes.push(node);
    this.emit("node.registered", { id, capacity });
    this.drainQueue("node.registered");
    return node;
  }

  createNamespace(name: string, quota: Resources): NamespaceInfo {
    if (this.namespaces.has(name)) {
      throw new ServiceError("CONFLICT", `namespace '${name}' already exists`, { name });
    }
    const ns: NamespaceInfo = { name, quota, used: { cpu: 0, memoryMb: 0 } };
    this.namespaces.set(name, ns);
    this.emit("namespace.created", { name, quota });
    return ns;
  }

  deleteNamespace(name: string): EvictionRecord[] {
    const ns = this.namespaces.get(name);
    if (!ns) throw new ServiceError("NOT_FOUND", `namespace '${name}' not found`, { name });
    const evictions: EvictionRecord[] = [];
    // evict running workloads, releasing node capacity + namespace quota
    for (const w of [...this.workloads.values()]) {
      if (w.namespace !== name) continue;
      if (w.status === "running" && w.nodeId) {
        const node = this.nodes.find((n) => n.id === w.nodeId)!;
        node.used = sub(node.used, w.request);
        ns.used = sub(ns.used, w.request);
        evictions.push({
          workloadId: w.id, namespace: name, nodeId: node.id,
          released: { ...w.request }, reason: "namespace.deleted",
        });
        this.emit("workload.evicted", { workloadId: w.id, nodeId: node.id, released: w.request, reason: "namespace.deleted" });
      }
      this.workloads.delete(w.id);
    }
    // drop queued requests of this namespace (they hold nothing)
    this.queue = this.queue.filter((id) => this.workloads.get(id)?.namespace !== name);
    this.namespaces.delete(name);
    this.emit("namespace.deleted", { name, evicted: evictions.map((e) => e.workloadId) });
    // freed capacity may unblock other namespaces' queued workloads
    this.drainQueue("namespace.deleted");
    return evictions;
  }

  placeWorkload(id: string, namespace: string, request: Resources): PlacementDecision {
    if (this.workloads.has(id)) {
      throw new ServiceError("CONFLICT", `workload '${id}' already exists`, { id });
    }
    const ns = this.namespaces.get(namespace);
    if (!ns) {
      throw new ServiceError("NOT_FOUND", `namespace '${namespace}' not found`, { namespace });
    }
    // quota check first: reject (do not queue) when the namespace quota cannot ever fit it
    const shortfall: QuotaShortfall = {
      cpu: Math.max(0, ns.used.cpu + request.cpu - ns.quota.cpu),
      memoryMb: Math.max(0, ns.used.memoryMb + request.memoryMb - ns.quota.memoryMb),
    };
    if (shortfall.cpu > 0 || shortfall.memoryMb > 0) {
      this.emit("workload.rejected", { workloadId: id, namespace, reason: "QUOTA_EXCEEDED", shortfall });
      throw new ServiceError(
        "QUOTA_EXCEEDED",
        `namespace '${namespace}' quota exceeded: short cpu=${shortfall.cpu} memoryMb=${shortfall.memoryMb}`,
        { namespace, shortfall },
      );
    }
    const w: Workload = { id, namespace, request, status: "queued", nodeId: null, createdSeq: ++this.seq };
    this.workloads.set(id, w);
    const node = this.firstFit(request);
    if (node) {
      this.assign(w, node);
      return { workloadId: id, outcome: "placed", nodeId: node.id, reason: `first-fit node '${node.id}'` };
    }
    this.queue.push(id);
    this.emit("workload.queued", { workloadId: id, namespace, request, reason: "NO_CAPACITY" });
    return { workloadId: id, outcome: "queued", nodeId: null, reason: "no node with sufficient cpu+memory; queued FIFO" };
  }

  deleteWorkload(id: string): { released: Resources; nodeId: string | null } {
    const w = this.workloads.get(id);
    if (!w) throw new ServiceError("NOT_FOUND", `workload '${id}' not found`, { id });
    let released: Resources = { cpu: 0, memoryMb: 0 };
    let nodeId: string | null = null;
    if (w.status === "running" && w.nodeId) {
      const node = this.nodes.find((n) => n.id === w.nodeId)!;
      node.used = sub(node.used, w.request);
      const ns = this.namespaces.get(w.namespace);
      if (ns) ns.used = sub(ns.used, w.request);
      released = { ...w.request };
      nodeId = node.id;
      this.emit("capacity.released", { workloadId: id, nodeId: node.id, released });
    } else {
      this.queue = this.queue.filter((q) => q !== id);
      this.emit("workload.dequeued", { workloadId: id });
    }
    this.workloads.delete(id);
    this.drainQueue("workload.deleted");
    return { released, nodeId };
  }

  /** Deterministic first-fit: lowest registration seq whose remaining capacity covers req. */
  private firstFit(req: Resources): NodeInfo | null {
    for (const n of this.nodes) {
      if (fits(n.capacity, n.used, req)) return n;
    }
    return null;
  }

  private assign(w: Workload, node: NodeInfo): void {
    node.used = add(node.used, w.request);
    const ns = this.namespaces.get(w.namespace)!;
    ns.used = add(ns.used, w.request);
    w.status = "running";
    w.nodeId = node.id;
    this.emit("workload.placed", { workloadId: w.id, nodeId: node.id, namespace: w.namespace, request: w.request });
  }

  /** After any release, retry the FIFO queue in order; stop at first request that still cannot fit. */
  private drainQueue(trigger: string): void {
    let progressed = true;
    while (progressed && this.queue.length > 0) {
      progressed = false;
      const id = this.queue[0];
      const w = this.workloads.get(id);
      if (!w) { this.queue.shift(); progressed = true; continue; }
      const ns = this.namespaces.get(w.namespace);
      if (!ns) { this.queue.shift(); this.workloads.delete(id); progressed = true; continue; }
      if (!fits(ns.quota, ns.used, w.request)) break; // quota still blocks the head; FIFO preserved
      const node = this.firstFit(w.request);
      if (!node) break;
      this.queue.shift();
      this.assign(w, node);
      this.emit("queue.drained", { workloadId: id, nodeId: node.id, trigger });
      progressed = true;
    }
  }

  // ---- diagnostics / conservation audit ----

  getNodes(): NodeInfo[] { return this.nodes.map((n) => ({ ...n, used: { ...n.used } })); }
  getNamespaces(): NamespaceInfo[] {
    return [...this.namespaces.values()].map((n) => ({ ...n, used: { ...n.used } }));
  }
  getWorkloads(): Workload[] { return [...this.workloads.values()].map((w) => ({ ...w })); }
  getQueue(): string[] { return [...this.queue]; }

  /** Conservation check: sum of running workload requests == node used == namespace used, per dimension. */
  audit(): { ok: boolean; nodeDelta: Resources; namespaceDelta: Resources } {
    const sum = { cpu: 0, memoryMb: 0 };
    for (const w of this.workloads.values()) {
      if (w.status !== "running") continue;
      sum.cpu += w.request.cpu;
      sum.memoryMb += w.request.memoryMb;
    }
    const nodeUsed = this.nodes.reduce((a, n) => add(a, n.used), { cpu: 0, memoryMb: 0 });
    const nsUsed = [...this.namespaces.values()].reduce((a, n) => add(a, n.used), { cpu: 0, memoryMb: 0 });
    const nodeDelta = sub(nodeUsed, sum);
    const namespaceDelta = sub(nsUsed, sum);
    const ok = nodeDelta.cpu === 0 && nodeDelta.memoryMb === 0 && namespaceDelta.cpu === 0 && namespaceDelta.memoryMb === 0;
    return { ok, nodeDelta, namespaceDelta };
  }
}
