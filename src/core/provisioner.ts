import type { Store } from '../state/store.ts';
import type { Clock } from '../clock.ts';
import type { ServiceConfig } from '../config.ts';
import type { InstanceRow, InstanceState } from '../state/db.ts';
import type { TemplateInput } from '../contracts/template.ts';
import { parseProvisionRequest } from '../contracts/provision.ts';
import { conflictActiveInstance, notFound, stateConflict, terminalState } from '../errors.ts';

export interface ProvisionResult {
  instance: InstanceRow;
  queued: boolean;
  queuePosition: number | null;
}

/**
 * Execution kernel: drives instances through the state machine
 * pending -> provisioning -> ready -> suspended -> ready ... -> deleted.
 * Enforces the global concurrency limit with a FIFO queue and performs
 * idle-timeout suspension on every clock tick.
 */
export class Provisioner {
  private queue: number[] = [];
  private dueAt = new Map<number, number>();

  private store: Store;
  private clock: Clock;
  private cfg: ServiceConfig;
  constructor(store: Store, clock: Clock, cfg: ServiceConfig) {
    this.store = store;
    this.clock = clock;
    this.cfg = cfg;
    if ('onTick' in clock && typeof (clock as any).onTick === 'function') {
      (clock as any).onTick(() => this.tick());
    }
  }

  provision(template: TemplateInput, body: unknown): ProvisionResult {
    const req = parseProvisionRequest(body, template);
    const active = this.store.findActiveByName(req.envName);
    if (active) throw conflictActiveInstance(req.envName);

    const cpu = req.overrides.cpu ?? template.cpu;
    const memoryMb = req.overrides.memoryMb ?? template.memoryMb;
    const now = this.clock.now();
    let inst = this.store.createInstance(req.envName, template.name, cpu, memoryMb, now);
    inst = this.transition(inst, 'pending', 'provision_requested', undefined, 'none');
    return this.tryStart(inst);
  }

  private tryStart(inst: InstanceRow): ProvisionResult {
    const inFlight = this.store.listInstances({ state: 'provisioning' }).length;
    if (inFlight < this.cfg.maxConcurrentProvisions) {
      const started = this.transition(inst, 'provisioning', 'slot_acquired');
      this.dueAt.set(started.id, this.clock.now() + this.cfg.provisionDurationMs);
      return { instance: started, queued: false, queuePosition: null };
    }
    this.queue.push(inst.id);
    return { instance: inst, queued: true, queuePosition: this.queue.length };
  }

  /** Advance asynchronous work: complete due provisions, drain FIFO queue, suspend idle instances. */
  tick(): void {
    const now = this.clock.now();
    for (const inst of this.store.listInstances({ state: 'provisioning' })) {
      const due = this.dueAt.get(inst.id);
      if (due !== undefined && now >= due) {
        this.dueAt.delete(inst.id);
        this.transition(inst, 'ready', 'provision_complete', now);
      }
    }
    // Drain queue FIFO into freed slots
    while (this.queue.length > 0) {
      const inFlight = this.store.listInstances({ state: 'provisioning' }).length;
      if (inFlight >= this.cfg.maxConcurrentProvisions) break;
      const nextId = this.queue.shift()!;
      const next = this.store.getInstance(nextId);
      if (!next || next.state !== 'pending') continue;
      const started = this.transition(next, 'provisioning', 'slot_acquired');
      this.dueAt.set(started.id, now + this.cfg.provisionDurationMs);
    }
    // Idle timeout: ready instances past their template's idleTimeoutMs are suspended
    for (const inst of this.store.listInstances({ state: 'ready' })) {
      const template = this.store.getTemplate(inst.template);
      if (!template || inst.last_ready_at == null) continue;
      if (now - inst.last_ready_at > template.idleTimeoutMs) {
        this.transition(inst, 'suspended', 'idle_timeout');
      }
    }
  }

  resume(name: string): InstanceRow {
    const inst = this.mustGet(name);
    if (inst.state === 'deleted') throw terminalState(name);
    if (inst.state !== 'suspended') {
      throw stateConflict("cannot resume environment in state '" + inst.state + "' (expected 'suspended')", inst.state);
    }
    // Resume restarts the idle clock.
    return this.transition(inst, 'ready', 'resume', this.clock.now());
  }

  suspend(name: string): InstanceRow {
    const inst = this.mustGet(name);
    if (inst.state === 'deleted') throw terminalState(name);
    if (inst.state !== 'ready') {
      throw stateConflict("cannot suspend environment in state '" + inst.state + "' (expected 'ready')", inst.state);
    }
    return this.transition(inst, 'suspended', 'manual_suspend');
  }

  delete(name: string): InstanceRow {
    const inst = this.mustGet(name);
    if (inst.state === 'deleted') throw terminalState(name);
    this.queue = this.queue.filter((id) => id !== inst.id);
    this.dueAt.delete(inst.id);
    const deleted = this.transition(inst, 'deleted', 'delete_requested');
    // Deleting may free a provisioning slot; drain the queue.
    this.tick();
    return deleted;
  }

  get(name: string): InstanceRow {
    return this.mustGet(name);
  }

  list(filter: { template?: string; state?: InstanceState } = {}): InstanceRow[] {
    return this.store.listInstances(filter);
  }

  history(name: string) {
    const inst = this.mustGetAny(name);
    return this.store.history(inst.id);
  }

  diagnostics() {
    const byState: Record<string, number> = {};
    for (const s of ['pending', 'provisioning', 'ready', 'suspended', 'deleted']) {
      byState[s] = this.store.listInstances({ state: s as InstanceState }).length;
    }
    return {
      now: this.clock.now(),
      maxConcurrentProvisions: this.cfg.maxConcurrentProvisions,
      queueDepth: this.queue.length,
      queue: [...this.queue],
      instancesByState: byState,
      recentTransitions: this.store.recentTransitions(20),
    };
  }

  private mustGet(name: string): InstanceRow {
    const inst = this.store.getInstanceByName(name);
    if (!inst) throw notFound('environment ' + name);
    return inst;
  }

  private mustGetAny(name: string): InstanceRow {
    return this.mustGet(name);
  }

  private transition(inst: InstanceRow, to: InstanceState, reason: string, lastReadyAt?: number, fromOverride?: string): InstanceRow {
    const runId = inst.run_counter + 1;
    return this.store.applyTransition(inst.id, to, {
      runId,
      from: fromOverride ?? inst.state,
      to,
      reason,
      at: this.clock.now(),
    }, lastReadyAt);
  }
}
