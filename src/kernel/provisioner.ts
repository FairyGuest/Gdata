// Execution kernel: template registry, FIFO provisioning queue with a global
// concurrency cap, and the instance state machine
//   PENDING -> PROVISIONING -> READY -> SUSPENDED -> (resume) READY ... -> DELETED
// All time-based behaviour runs on the injected VirtualClock.

import { randomUUID } from 'node:crypto';
import type {
  InstanceQuery,
  InstanceRecord,
  InstanceStatus,
  ProvisionRequest,
  TemplateSpec,
  TransitionRecord,
} from '../domain/types.ts';
import { DomainError } from '../domain/errors.ts';
import { validateTemplate, applyOverrides } from '../domain/template.ts';
import type { ServiceConfig } from '../config.ts';
import type { VirtualClock } from './clock.ts';
import type { InstanceStore } from '../store/sqlite.ts';

interface QueueEntry {
  instanceId: string;
  template: TemplateSpec;
}

export class Provisioner {
  private templates = new Map<string, TemplateSpec>();
  private queue: QueueEntry[] = [];
  private provisioningCount = 0;
  private idleTimers = new Map<string, number>();

  private readonly clock: VirtualClock;
  private readonly store: InstanceStore;
  private readonly config: ServiceConfig;

  constructor(clock: VirtualClock, store: InstanceStore, config: ServiceConfig) {
    this.clock = clock;
    this.store = store;
    this.config = config;
  }

  registerTemplate(spec: unknown): TemplateSpec {
    const t = validateTemplate(spec, this.config);
    this.templates.set(t.name, t);
    return t;
  }

  getTemplate(name: string): TemplateSpec {
    const t = this.templates.get(name);
    if (!t) throw new DomainError('INSTANCE_NOT_FOUND', 'template not found: ' + name, { template: name });
    return t;
  }

  listTemplates(): TemplateSpec[] {
    return [...this.templates.values()];
  }

  provision(req: ProvisionRequest): InstanceRecord {
    const template = this.getTemplate(req.template);
    const resources = applyOverrides(template, req.overrides);
    if (!req.name || typeof req.name !== 'string') {
      throw new DomainError('TEMPLATE_VALIDATION', 'instance name is required');
    }
    const existing = this.store.findActiveByName(req.name);
    if (existing) {
      throw new DomainError('NAME_CONFLICT',
        'an active instance named ' + JSON.stringify(req.name) + ' already exists',
        { name: req.name, existingId: existing.id, existingStatus: existing.status });
    }
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new DomainError('RESOURCE_EXHAUSTED',
        'provisioning queue is full (' + this.config.maxQueueSize + ')', { queueSize: this.queue.length });
    }

    const now = this.clock.now();
    const instance: InstanceRecord = {
      id: randomUUID(),
      name: req.name,
      template: template.name,
      status: 'PENDING',
      resources,
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(instance);
    this.record(instance.id, null, 'PENDING', 'provision-requested');
    this.queue.push({ instanceId: instance.id, template });
    this.pumpQueue();
    return this.store.getById(instance.id)!;
  }

  resume(name: string): InstanceRecord {
    const inst = this.requireByName(name);
    if (inst.status !== 'SUSPENDED') {
      throw new DomainError('INVALID_TRANSITION',
        'cannot resume instance in status ' + inst.status,
        { name, status: inst.status });
    }
    this.transition(inst, 'READY', 'manual-resume');
    return this.store.getById(inst.id)!;
  }

  delete(name: string): InstanceRecord {
    const inst = this.requireByName(name);
    this.queue = this.queue.filter((e) => e.instanceId !== inst.id);
    if (inst.status === 'PROVISIONING') this.provisioningCount--;
    this.clearIdleTimer(inst.id);
    this.transition(inst, 'DELETED', 'delete-requested');
    this.pumpQueue();
    return this.store.getById(inst.id)!;
  }

  get(name: string): InstanceRecord {
    return this.requireByName(name);
  }

  query(q: InstanceQuery): InstanceRecord[] {
    return this.store.query(q);
  }

  history(name: string): TransitionRecord[] {
    // History remains readable even for deleted (terminal) instances.
    const inst = this.store.getByName(name);
    if (!inst) throw new DomainError('INSTANCE_NOT_FOUND', 'instance not found: ' + name, { name });
    return this.store.history(inst.id);
  }

  diagnostics() {
    return {
      clockNowMs: this.clock.now(),
      pendingQueue: this.queue.map((e) => e.instanceId),
      provisioningCount: this.provisioningCount,
      maxConcurrentProvisions: this.config.maxConcurrentProvisions,
      maxQueueSize: this.config.maxQueueSize,
      templates: this.templates.size,
    };
  }

  // ---- internals ----

  private requireByName(name: string): InstanceRecord {
    const inst = this.store.getByName(name);
    if (!inst) throw new DomainError('INSTANCE_NOT_FOUND', 'instance not found: ' + name, { name });
    if (inst.status === 'DELETED') {
      throw new DomainError('TERMINAL_STATE',
        'instance ' + JSON.stringify(name) + ' is deleted (terminal state)',
        { name, status: 'DELETED' });
    }
    return inst;
  }

  private transition(inst: InstanceRecord, to: InstanceStatus, reason: string): void {
    const from = inst.status;
    this.store.updateStatus(inst.id, to, this.clock.now());
    this.record(inst.id, from, to, reason);
    if (to === 'READY') {
      this.armIdleTimer(inst.id, inst.template);
    } else {
      this.clearIdleTimer(inst.id);
    }
  }

  private record(instanceId: string, from: InstanceStatus | null, to: InstanceStatus, reason: string): void {
    const seq = this.store.history(instanceId).length + 1;
    this.store.recordTransition({
      instanceId,
      runId: instanceId.slice(0, 8) + '#' + seq,
      fromStatus: from,
      toStatus: to,
      reason,
      at: this.clock.now(),
    });
  }

  private pumpQueue(): void {
    while (this.provisioningCount < this.config.maxConcurrentProvisions && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const inst = this.store.getById(entry.instanceId);
      if (!inst || inst.status !== 'PENDING') continue; // deleted while queued
      this.provisioningCount++;
      this.transition(inst, 'PROVISIONING', 'dequeued-for-provisioning');
      this.clock.setTimeout(() => {
        const current = this.store.getById(entry.instanceId);
        if (!current || current.status !== 'PROVISIONING') return; // deleted mid-flight
        this.provisioningCount--;
        this.transition(current, 'READY', 'provision-complete');
        this.pumpQueue();
      }, this.config.provisionDurationMs);
    }
  }

  private armIdleTimer(instanceId: string, templateName: string): void {
    this.clearIdleTimer(instanceId);
    const template = this.templates.get(templateName);
    if (!template) return;
    const timerId = this.clock.setTimeout(() => {
      const inst = this.store.getById(instanceId);
      if (inst && inst.status === 'READY') {
        this.transition(inst, 'SUSPENDED', 'idle-timeout-' + template.idleTimeoutMs + 'ms');
      }
    }, template.idleTimeoutMs);
    this.idleTimers.set(instanceId, timerId);
  }

  private clearIdleTimer(instanceId: string): void {
    const id = this.idleTimers.get(instanceId);
    if (id != null) {
      this.clock.clearTimeout(id);
      this.idleTimers.delete(instanceId);
    }
  }
}
