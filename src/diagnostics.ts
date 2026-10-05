// Diagnostics / admin API: control faults, inspect status and history.
import { Router, sendJson, type Ctx } from './http.ts';
import { FAULT_TYPES, ChaosError, type FaultType } from './contracts.ts';
import type { FaultManager } from './state.ts';

export function registerDiagnostics(router: Router, fm: FaultManager, runId: string): void {
  router.get('/health', ({ res }) => sendJson(res, 200, { ok: true, runId }));

  router.get('/chaos/status', ({ res }) => sendJson(res, 200, { runId, active: fm.list() }));

  router.post('/chaos/faults/:type/start', ({ res, params, body }: Ctx) => {
    const type = params.type as FaultType;
    if (!FAULT_TYPES.includes(type)) throw ChaosError.invalidConfig(`unknown fault type: ${params.type}. valid: ${FAULT_TYPES.join(', ')}`);
    const fault = fm.start(type, body ?? {});
    sendJson(res, 201, { started: fault });
  });

  router.post('/chaos/faults/:type/stop', ({ res, params }: Ctx) => {
    const type = params.type as FaultType;
    if (!FAULT_TYPES.includes(type)) throw ChaosError.invalidConfig(`unknown fault type: ${params.type}`);
    const stopped = fm.stop(type);
    sendJson(res, 200, { stopped });
  });

  router.post('/chaos/stop-all', ({ res }) => sendJson(res, 200, { stopped: fm.stopAll() }));

  router.get('/chaos/sessions', ({ res }) => sendJson(res, 200, { sessions: fm.sessions() }));

  router.get('/chaos/sessions/:id', ({ res, params }) => sendJson(res, 200, fm.sessionStats(params.id)));

  router.get('/chaos/sessions/:id/events', ({ res, params }) => {
    sendJson(res, 200, { events: fm.sessionStats(params.id).events });
  });
}
