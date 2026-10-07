import { randomUUID } from 'node:crypto';
import { DomainError, errorBody } from '../domain/errors.ts';
import { validateDefinition } from '../domain/validate.ts';
import { impactClosure } from '../domain/impact.ts';
import { planOrchestration } from '../kernel/planner.ts';
import { executeStart } from '../kernel/executor.ts';
import { RunLogger } from '../kernel/logger.ts';
import type { OrchestratorStore } from '../store/db.ts';
import type { AppConfig } from '../config.ts';
import type { OrchestrationDef, ServiceDef } from '../domain/types.ts';

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface RouteReply {
  statusCode: number;
  code(status: number): RouteReply;
  send(payload: unknown): unknown;
}

export interface RouteApp {
  get(pattern: string, handler: (req: RouteRequest, reply: RouteReply) => unknown): void;
  post(pattern: string, handler: (req: RouteRequest, reply: RouteReply) => unknown): void;
  put(pattern: string, handler: (req: RouteRequest, reply: RouteReply) => unknown): void;
}

const STATUS_BY_CATEGORY: Record<string, number> = {
  INPUT_ERROR: 400,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 507,
  COMPUTE_FAILURE: 500,
};

type Handler = (req: RouteRequest, reply: RouteReply) => unknown;

function wrap(handler: Handler): Handler {
  return (req, reply) => {
    try {
      return handler(req, reply);
    } catch (err) {
      if (err instanceof DomainError) {
        reply.code(STATUS_BY_CATEGORY[err.category] ?? 500);
        return errorBody(err);
      }
      reply.code(500);
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: {
          category: 'COMPUTE_FAILURE',
          code: 'INTERNAL',
          message: 'unexpected failure: ' + message,
          details: null,
        },
      };
    }
  };
}

function parseVersion(query: Record<string, string>): number | undefined {
  const raw = query.version;
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new DomainError('INPUT_ERROR', 'BAD_VERSION', 'version query parameter must be a positive integer', { version: raw });
  }
  return v;
}

function loadDefinition(store: OrchestratorStore, name: string, version?: number): { version: number; definition: OrchestrationDef } {
  const row = store.getDefinition(name, version);
  if (!row) {
    throw new DomainError('NOT_FOUND', version === undefined ? 'ORCHESTRATION_NOT_FOUND' : 'VERSION_NOT_FOUND',
      version === undefined
        ? 'orchestration "' + name + '" does not exist'
        : 'orchestration "' + name + '" has no version ' + version,
      { name, version: version ?? null });
  }
  return row;
}

export function registerRoutes(app: RouteApp, store: OrchestratorStore, config: AppConfig): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.post('/orchestrations', wrap((req, reply) => {
    const runId = randomUUID();
    const logger = new RunLogger(store, runId);
    const body = req.body as Partial<OrchestrationDef> | undefined;
    if (body && Array.isArray(body.services) && body.services.length > config.maxServices) {
      throw new DomainError('RESOURCE_EXHAUSTED', 'TOO_MANY_SERVICES', 'service count exceeds configured limit', {
        count: body.services.length,
        maxServices: config.maxServices,
      });
    }
    logger.info('request.received', { route: 'POST /orchestrations', name: body?.name ?? null });
    const def = validateDefinition(req.body);
    if (store.hasOrchestration(def.name)) {
      throw new DomainError('STATE_CONFLICT', 'ORCHESTRATION_EXISTS', 'orchestration "' + def.name + '" already exists; update services via PUT', { name: def.name });
    }
    const plan = planOrchestration(def, logger);
    const version = store.createOrchestration(def.name, def);
    store.saveComputation(def.name, version, 'plan', runId, plan);
    logger.info('orchestration.created', { name: def.name, version });
    reply.code(201);
    return { name: def.name, version, plan, runId };
  }));

  app.get('/orchestrations/:name', wrap((req) => {
    const { definition, version } = loadDefinition(store, req.params.name);
    return { name: req.params.name, version, versions: store.listVersions(req.params.name), definition };
  }));

  app.put('/orchestrations/:name/services/:service', wrap((req) => {
    const runId = randomUUID();
    const logger = new RunLogger(store, runId);
    const name = req.params.name;
    const serviceName = req.params.service;
    const { definition } = loadDefinition(store, name);
    const incoming = req.body as Partial<ServiceDef> | undefined;
    if (!incoming || incoming.name !== serviceName) {
      throw new DomainError('INPUT_ERROR', 'SERVICE_NAME_MISMATCH', 'request body must be the full service definition whose name matches the URL', {
        urlService: serviceName,
        bodyName: incoming?.name ?? null,
      });
    }
    const merged: OrchestrationDef = {
      name: definition.name,
      services: definition.services.map((s) => (s.name === serviceName ? (incoming as ServiceDef) : s)),
    };
    if (!merged.services.some((s) => s.name === serviceName)) {
      throw new DomainError('NOT_FOUND', 'SERVICE_NOT_FOUND', 'service "' + serviceName + '" is not part of orchestration "' + name + '"', { name, service: serviceName });
    }
    const validated = validateDefinition(merged);
    const impact = impactClosure(validated, serviceName);
    const plan = planOrchestration(validated, logger);
    const version = store.addVersion(name, validated);
    store.saveComputation(name, version, 'plan', runId, plan);
    store.saveComputation(name, version, 'impact', runId, impact);
    logger.info('service.updated', {
      name,
      service: serviceName,
      version,
      reason: 'impact = changed service plus transitive dependents; all others skipped',
      impact,
    });
    return { name, version, impact, plan, runId };
  }));

  app.get('/orchestrations/:name/plan', wrap((req) => {
    const version = parseVersion(req.query);
    const row = loadDefinition(store, req.params.name, version);
    const stored = store.getComputation(req.params.name, row.version, 'plan');
    if (!stored) {
      throw new DomainError('NOT_FOUND', 'PLAN_NOT_FOUND', 'no stored plan for orchestration "' + req.params.name + '" version ' + row.version, { name: req.params.name, version: row.version });
    }
    return { name: req.params.name, version: row.version, plan: stored.result, runId: stored.runId, computedAt: stored.createdAt };
  }));

  app.post('/orchestrations/:name/execute', wrap((req, reply) => {
    const runId = randomUUID();
    const logger = new RunLogger(store, runId);
    const version = parseVersion(req.query);
    const row = loadDefinition(store, req.params.name, version);
    logger.info('execute.requested', { name: req.params.name, version: row.version });
    const result = executeStart(row.definition, logger);
    store.saveComputation(req.params.name, row.version, 'execution', runId, result);
    if (result.status === 'FAILED') {
      reply.code(422);
    }
    return { name: req.params.name, version: row.version, execution: result, runId };
  }));

  app.get('/diagnostics/runs/:runId', wrap((req) => {
    const logs = store.getLogs(req.params.runId);
    if (logs.length === 0) {
      throw new DomainError('NOT_FOUND', 'RUN_NOT_FOUND', 'no logs recorded for run id "' + req.params.runId + '"', { runId: req.params.runId });
    }
    return { runId: req.params.runId, entries: logs };
  }));
}
