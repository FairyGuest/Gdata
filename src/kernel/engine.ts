import { randomUUID } from 'node:crypto';
import { ResourceExhaustedError, StateConflictError } from '../contracts/errors';
import { FaultDecision, InjectionSession, StartInjectionInput } from '../contracts/types';
import { ChaosStore } from '../state/store';

export interface EngineOptions {
  maxActiveInjections: number;
  rng?: () => number;
  now?: () => number;
}

/**
 * Execution kernel: owns injection lifecycle (start / auto-stop / manual stop)
 * and per-request fault decisions. Every applied fault is persisted as an
 * event with timestamp, type, duration and the affected request id.
 */
export class ChaosEngine {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly maxActive: number;

  constructor(private readonly store: ChaosStore, opts: EngineOptions) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.maxActive = opts.maxActiveInjections;
  }

  start(input: StartInjectionInput): InjectionSession {
    const existing = this.store.findActiveByFaultType(input.faultType);
    if (existing) {
      throw new StateConflictError(
        'an active injection for faultType "' + input.faultType + '" already exists',
        { activeSessionId: existing.id, faultType: input.faultType },
      );
    }
    if (this.store.countActive() >= this.maxActive) {
      throw new ResourceExhaustedError('active injection limit reached', {
        maxActiveInjections: this.maxActive,
      });
    }
    const startedAt = this.now();
    const session: InjectionSession = {
      id: randomUUID(),
      faultType: input.faultType,
      probability: input.probability,
      durationMs: input.durationMs,
      params: input.params,
      status: 'active',
      startedAt,
      endsAt: input.durationMs === null ? null : startedAt + input.durationMs,
      endedAt: null,
    };
    this.store.insertInjection(session);
    if (input.durationMs !== null) {
      const timer = setTimeout(() => this.expire(session.id), input.durationMs);
      timer.unref();
      this.timers.set(session.id, timer);
    }
    return session;
  }

  stop(id: string): InjectionSession {
    const session = this.store.getInjection(id);
    if (!session) {
      throw new StateConflictError('injection not found', { sessionId: id });
    }
    if (session.status !== 'active') {
      throw new StateConflictError('injection is not active', { sessionId: id, status: session.status });
    }
    return this.finish(id, 'stopped');
  }

  stopAll(): InjectionSession[] {
    return this.store.listActive().map((s) => this.finish(s.id, 'stopped'));
  }

  list(): InjectionSession[] {
    return this.store.listInjections();
  }

  private expire(id: string): void {
    const session = this.store.getInjection(id);
    if (session && session.status === 'active') {
      this.finish(id, 'expired');
    }
  }

  private finish(id: string, status: 'stopped' | 'expired'): InjectionSession {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const endedAt = this.now();
    this.store.updateInjectionStatus(id, status, endedAt);
    return this.store.getInjection(id)!;
  }

  /**
   * Roll each active injection for one request. Every winning roll is
   * recorded as a fault event before the decision is returned.
   */
  decide(requestId: string): FaultDecision[] {
    const decisions: FaultDecision[] = [];
    for (const session of this.store.listActive()) {
      const roll = this.rng();
      if (roll < session.probability) {
        const durationMs = session.faultType === 'latency' ? session.params.delayMs ?? 0 : 0;
        this.store.insertFaultEvent({
          requestId,
          sessionId: session.id,
          faultType: session.faultType,
          timestamp: this.now(),
          durationMs,
          detail: JSON.stringify({ roll, probability: session.probability, params: session.params }),
        });
        decisions.push({
          sessionId: session.id,
          faultType: session.faultType,
          params: session.params,
        });
      }
    }
    return decisions;
  }

  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}