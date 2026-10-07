// Contract layer: template parsing + override validation.
// Produces the effective configuration consumed by the execution kernel.

import { createHash } from 'node:crypto';
import { LifecycleError, ErrorCodes } from './errors.ts';
import type { EnvironmentTemplate, ParamDecl, ParamValue } from './types.ts';

export function parseTemplate(raw: unknown): EnvironmentTemplate {
  const t = raw as EnvironmentTemplate;
  if (!t || typeof t.name !== 'string' || !Array.isArray(t.services) || typeof t.params !== 'object') {
    throw new LifecycleError(ErrorCodes.INVALID_REQUEST, 'template is malformed', {});
  }
  for (const [key, decl] of Object.entries(t.params)) {
    const d = decl as ParamDecl;
    if (!['string', 'number', 'boolean'].includes(d?.type) || typeof d.default !== d.type) {
      throw new LifecycleError(ErrorCodes.INVALID_REQUEST, 'template param declaration is malformed', { param: key });
    }
  }
  return t;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Merge template defaults with caller overrides. Unknown params and type
// mismatches are rejected, naming the offending parameter.
export function resolveEffectiveParams(
  template: EnvironmentTemplate,
  overrides: Record<string, unknown> = {},
): Record<string, ParamValue> {
  const effective: Record<string, ParamValue> = {};
  for (const [key, decl] of Object.entries(template.params)) {
    effective[key] = decl.default;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const decl = template.params[key];
    if (!decl) {
      throw new LifecycleError(ErrorCodes.UNKNOWN_PARAM, `unknown parameter: ${key}`, { param: key });
    }
    if (typeof value !== decl.type) {
      throw new LifecycleError(
        ErrorCodes.PARAM_TYPE_MISMATCH,
        `parameter ${key} expects ${decl.type}, got ${typeOf(value)}`,
        { param: key, expected: decl.type, actual: typeOf(value) },
      );
    }
    effective[key] = value as ParamValue;
  }
  return effective;
}

export function resolveTtl(template: EnvironmentTemplate, ttlSeconds?: number): number {
  if (ttlSeconds === undefined) return template.defaultTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > template.maxTtlSeconds) {
    throw new LifecycleError(ErrorCodes.INVALID_TTL, `ttlSeconds must be an integer in (0, ${template.maxTtlSeconds}]`, {
      ttlSeconds,
      maxTtlSeconds: template.maxTtlSeconds,
    });
  }
  return ttlSeconds;
}

// Canonical hash of effective params; defines idempotency equivalence.
export function hashParams(params: Record<string, ParamValue>): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

