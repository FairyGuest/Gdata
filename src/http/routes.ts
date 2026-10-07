// HTTP contract: route table shared by every server adapter, plus the
// LifecycleError -> HTTP status mapping. Adapters only do transport.

import { ErrorCodes, isLifecycleError } from '../contract/errors.ts';
import type { ErrorCode } from '../contract/errors.ts';
import type { LifecycleEngine } from '../core/engine.ts';
import type { EnvStatus } from '../contract/types.ts';
import type { EnvironmentStore } from '../store/sqlite.ts';

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCodes.UNKNOWN_PARAM]: 400,
  [ErrorCodes.PARAM_TYPE_MISMATCH]: 400,
  [ErrorCodes.INVALID_TTL]: 400,
  [ErrorCodes.INVALID_REQUEST]: 400,
  [ErrorCodes.FORCE_REASON_REQUIRED]: 400,
  [ErrorCodes.BRANCH_PARAM_CONFLICT]: 409,
  [ErrorCodes.QUOTA_EXCEEDED]: 409,
  [ErrorCodes.DELETE_LOCKED]: 409,
  [ErrorCodes.INVALID_STATE]: 409,
  [ErrorCodes.ENV_NOT_FOUND]: 404,
  [ErrorCodes.INTERNAL]: 500,
};

export interface HttpRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (req: HttpRequest) => HttpResponse;
}

function ok(status: number, body: unknown): HttpResponse {
  return { status, body };
}

export function buildRoutes(engine: LifecycleEngine, store: EnvironmentStore, runId: string): Route[] {
  const defs: Array<{ method: Route['method']; path: string; handler: (req: HttpRequest) => HttpResponse }> = [
    {
      method: 'GET',
      path: '/health',
      handler: () => ok(200, { status: 'ok', runId }),
    },
    {
      method: 'POST',
      path: '/environments',
      handler: (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = engine.create({
          owner: body.owner as string,
          branch: body.branch as string,
          overrides: (body.overrides ?? {}) as Record<string, unknown>,
          ttlSeconds: body.ttlSeconds as number | undefined,
        });
        return ok(result.idempotent ? 200 : 201, { id: result.env.id, idempotent: result.idempotent, env: result.env });
      },
    },
    {
      method: 'GET',
      path: '/environments/:id',
      handler: (req) => ok(200, { env: engine.get(req.params.id) }),
    },
    {
      method: 'POST',
      path: '/environments/:id/deploy-complete',
      handler: (req) => ok(200, { env: engine.markActive(req.params.id) }),
    },
    {
      method: 'POST',
      path: '/environments/:id/renew',
      handler: (req) => ok(200, { env: engine.renew(req.params.id) }),
    },
    {
      method: 'DELETE',
      path: '/environments/:id',
      handler: (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const force = req.query.force === 'true' || body.force === true;
        const reason = (req.query.reason ?? body.reason) as string | undefined;
        const env = engine.remove(req.params.id, { force, reason });
        return ok(200, { env });
      },
    },
    {
      method: 'POST',
      path: '/admin/sweep',
      handler: () => ok(200, { reclaimed: engine.sweep() }),
    },
    {
      method: 'GET',
      path: '/diagnostics/environments',
      handler: (req) => ok(200, {
        environments: engine.query({
          branch: req.query.branch,
          status: req.query.status as EnvStatus | undefined,
        }),
      }),
    },
    {
      method: 'GET',
      path: '/diagnostics/environments/:id/transitions',
      handler: (req) => ok(200, { transitions: store.transitions(req.params.id) }),
    },
    {
      method: 'GET',
      path: '/diagnostics/audit',
      handler: (req) => ok(200, {
        audit: store.auditLog({ envId: req.query.envId, action: req.query.action }),
      }),
    },
  ];

  return defs.map((d) => {
    const paramNames: string[] = [];
    const pattern = new RegExp('^' + d.path.replace(/:[^/]+/g, (m) => {
      paramNames.push(m.slice(1));
      return '([^/]+)';
    }) + '$');
    return { ...d, pattern, paramNames };
  });
}

export function errorToResponse(err: unknown): HttpResponse {
  if (isLifecycleError(err)) {
    return { status: ERROR_HTTP_STATUS[err.code], body: err.toJSON() };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: ErrorCodes.INTERNAL, message, details: {} } } };
}

