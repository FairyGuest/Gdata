// Contract layer: template parsing + parameter validation.
// A template declares services and typed parameters with defaults.
// Overrides are validated against declared types; unknown params and
// type mismatches are rejected naming the offending key.

import { ParamValidationError } from '../errors.ts';

export type ParamType = 'string' | 'number' | 'boolean';

export interface ParamDecl {
  type: ParamType;
  default: unknown;
  required?: boolean;
}

export interface Template {
  name: string;
  services: string[];
  params: Record<string, ParamDecl>;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export type EffectiveConfig = Record<string, string | number | boolean>;

const VALID_TYPES: ParamType[] = ['string', 'number', 'boolean'];

function typeOf(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

export function parseTemplate(raw: unknown): Template {
  if (typeof raw !== 'object' || raw === null) {
    throw new ParamValidationError('template must be an object', { got: typeOf(raw) });
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== 'string' || t.name.length === 0) {
    throw new ParamValidationError('template.name must be a non-empty string', { got: t.name });
  }
  if (!Array.isArray(t.services) || t.services.some((s) => typeof s !== 'string')) {
    throw new ParamValidationError('template.services must be an array of strings', { got: t.services });
  }
  if (typeof t.params !== 'object' || t.params === null) {
    throw new ParamValidationError('template.params must be an object', { got: t.params });
  }
  const params: Record<string, ParamDecl> = {};
  for (const [key, declRaw] of Object.entries(t.params as Record<string, unknown>)) {
    const decl = declRaw as Record<string, unknown>;
    if (typeof decl !== 'object' || decl === null || !VALID_TYPES.includes(decl.type as ParamType)) {
      throw new ParamValidationError(`template.params.${key}.type must be one of ${VALID_TYPES.join('|')}`, { got: declRaw });
    }
    const type = decl.type as ParamType;
    if ('default' in decl && typeOf(decl.default) !== type) {
      throw new ParamValidationError(`template.params.${key}.default does not match declared type '${type}'`, { got: decl.default });
    }
    if (!('default' in decl) && decl.required !== true) {
      throw new ParamValidationError(`template.params.${key} must declare a default or required:true`, {});
    }
    params[key] = { type, default: decl.default, required: decl.required === true };
  }
  const defaultTtlSeconds = typeof t.defaultTtlSeconds === 'number' ? t.defaultTtlSeconds : 3600;
  const maxTtlSeconds = typeof t.maxTtlSeconds === 'number' ? t.maxTtlSeconds : 86400;
  if (defaultTtlSeconds <= 0 || maxTtlSeconds < defaultTtlSeconds) {
    throw new ParamValidationError('template TTL bounds are inconsistent', { defaultTtlSeconds, maxTtlSeconds });
  }
  return { name: t.name, services: t.services as string[], params, defaultTtlSeconds, maxTtlSeconds };
}

export interface MergeResult {
  config: EffectiveConfig;
  ttlSeconds: number;
}

export function mergeOverrides(
  template: Template,
  overrides: Record<string, unknown> | undefined,
  ttlSeconds: number | undefined,
): MergeResult {
  const config: EffectiveConfig = {};
  const unknownKeys: string[] = [];
  const typeErrors: { key: string; expected: ParamType; got: string }[] = [];

  for (const [key, decl] of Object.entries(template.params)) {
    if (decl.default !== undefined) config[key] = decl.default as string | number | boolean;
  }

  if (overrides !== undefined) {
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
      throw new ParamValidationError('overrides must be an object mapping param names to values', { got: typeOf(overrides) });
    }
    for (const [key, value] of Object.entries(overrides)) {
      const decl = template.params[key];
      if (!decl) {
        unknownKeys.push(key);
        continue;
      }
      const got = typeOf(value);
      if (got !== decl.type) {
        typeErrors.push({ key, expected: decl.type, got });
        continue;
      }
      config[key] = value as string | number | boolean;
    }
  }

  if (unknownKeys.length > 0) {
    throw new ParamValidationError(
      `unknown parameter(s): ${unknownKeys.join(', ')}`,
      { unknownKeys },
    );
  }
  if (typeErrors.length > 0) {
    throw new ParamValidationError(
      `parameter type mismatch: ${typeErrors.map((e) => `${e.key} expected ${e.expected} got ${e.got}`).join('; ')}`,
      { typeErrors },
    );
  }

  const missing = Object.entries(template.params)
    .filter(([key, decl]) => decl.required === true && !(key in config))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new ParamValidationError(`missing required parameter(s): ${missing.join(', ')}`, { missing });
  }

  const ttl = ttlSeconds ?? template.defaultTtlSeconds;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > template.maxTtlSeconds) {
    throw new ParamValidationError(
      `ttlSeconds must be an integer in (0, ${template.maxTtlSeconds}]`,
      { ttlSeconds: ttl, maxTtlSeconds: template.maxTtlSeconds },
    );
  }
  return { config, ttlSeconds: ttl };
}
