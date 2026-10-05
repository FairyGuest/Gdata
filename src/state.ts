// State adapter: lifecycle of faults (manual start/stop + auto-stop timers) + persistence bridge.
import { randomUUID } from 'node:crypto';
import { ChaosError, log, type ActiveFault, type FaultConfig, type FaultEvent, type FaultType, type SessionRow } from './contracts.ts';
import { validateFaultConfig } from './config.ts';
import type { ChaosStore } from './store.ts';

export class FaultManager {
  private active = new Map<FaultType, ActiveFault>();
  private timers = new Map<FaultType, NodeJS.Timeout>();
  private store: ChaosStore;
  private runId: string;
  constructor(store: ChaosStore, runId: string) { this.store = store; this.runId = runId; }

  start(type: FaultType, rawConfig: unknown): ActiveFault {
    if (this.active.has(type)) throw ChaosError.conflict(`fault ${type} already active (session ${this.active.get(type)!.sessionId})`);
    const config: FaultConfig = validateFaultConfig(type, rawConfig);
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    const stopsAt = config.durationMs ? new Date(Date.now() + config.durationMs).toISOString() : null;
    const fault: ActiveFault = { type, sessionId, startedAt, stopsAt, ...config };
    this.store.openSession({ id: sessionId, fault_type: type, started_at: startedAt, ended_at: null, config_json: JSON.stringify(config) });
    if (config.durationMs) {
      this.timers.set(type, setTimeout(() => {
        log(this.runId, 'info', 'fault.autoStop', { type, sessionId, reason: `durationMs=${config.durationMs} elapsed` });
        this.stop(type);
      }, config.durationMs).unref());
    }
    this.active.set(type, fault);
    log(this.runId, 'info', 'fault.start', { type, sessionId, config, reason: 'manual start' });
    return fault;
  }

  stop(type: FaultType): ActiveFault {
    const f = this.active.get(type);
    if (!f) throw ChaosError.notActive(`fault ${type} is not active`);
    this.active.delete(type);
    const t = this.timers.get(type);
    if (t) { clearTimeout(t); this.timers.delete(type); }
    this.store.closeSession(f.sessionId, new Date().toISOString());
    log(this.runId, 'info', 'fault.stop', { type, sessionId: f.sessionId, reason: 'stopped (manual or auto)' });
    return f;
  }

  stopAll(): FaultType[] {
    return [...this.active.keys()].map((t) => { this.stop(t); return t; });
  }

  list(): ActiveFault[] { return [...this.active.values()]; }
  get(type: FaultType): ActiveFault | undefined { return this.active.get(type); }

  record(ev: Omit<FaultEvent, 'id' | 'timestamp'>): void {
    this.store.insertEvent({ ...ev, timestamp: new Date().toISOString() });
  }

  sessions(): SessionRow[] { return this.store.listSessions(); }
  sessionStats(sessionId: string) {
    const s = this.store.getSession(sessionId);
    if (!s) throw ChaosError.notFound(`session ${sessionId} not found`);
    return { session: s, affectedRequests: this.store.countEvents(sessionId), events: this.store.listEvents(sessionId) };
  }

  shutdown(): void { this.stopAll(); this.store.close(); }
}
