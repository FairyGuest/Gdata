// Contract-parsing layer: turns untrusted JSON into a validated RunConfig,
// or throws AppError(INPUT_ERROR) listing every violation.
import { inputError, type RunConfig } from './contracts.ts';

export const LIMITS = {
  maxRequests: 100_000,
  maxConcurrency: 1_000,
  maxIntervalMs: 60_000,
  maxTimeoutMs: 120_000,
} as const;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function parseRunConfig(raw: unknown): RunConfig {
  const problems: string[] = [];
  const body = (raw ?? {}) as Record<string, unknown>;

  const url = body.url;
  if (typeof url !== 'string' || !url) {
    problems.push('url is required and must be a string');
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        problems.push('url must use http or https');
      }
    } catch {
      problems.push('url is not a valid URL');
    }
  }

  const method = body.method === undefined ? 'GET' : String(body.method).toUpperCase();
  if (!METHODS.has(method)) problems.push('method must be one of ' + [...METHODS].join(','));

  const intField = (name: string, def: number, min: number, max: number): number => {
    const v = body[name] === undefined ? def : Number(body[name]);
    if (!Number.isInteger(v) || v < min) {
      problems.push(name + ' must be an integer >= ' + min);
      return def;
    }
    if (v > max) {
      problems.push(name + ' must be <= ' + max + ' (resource limit)');
      return def;
    }
    return v;
  };

  const requests = intField('requests', 10, 1, LIMITS.maxRequests);
  const concurrency = intField('concurrency', 2, 1, LIMITS.maxConcurrency);
  const intervalMs = intField('intervalMs', 0, 0, LIMITS.maxIntervalMs);
  const timeoutMs = intField('timeoutMs', 10_000, 1, LIMITS.maxTimeoutMs);

  let headers: Record<string, string> | undefined;
  if (body.headers !== undefined) {
    if (typeof body.headers !== 'object' || body.headers === null || Array.isArray(body.headers)) {
      problems.push('headers must be an object of string values');
    } else {
      headers = {};
      for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
        headers[k] = String(v);
      }
    }
  }

  let payload: string | undefined;
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') problems.push('body must be a string');
    else payload = body.body;
  }

  if (problems.length > 0) {
    throw inputError('invalid run config: ' + problems.join('; '));
  }

  return {
    url: url as string,
    method,
    headers,
    body: payload,
    requests,
    concurrency,
    intervalMs,
    timeoutMs,
  };
}
