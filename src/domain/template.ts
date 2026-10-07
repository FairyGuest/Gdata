// Contract parsing + validation for template specs and provision overrides.

import type { ResourceQuota, TemplateSpec } from './types.ts';
import { DomainError } from './errors.ts';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateTemplate(spec: unknown, limits: {
  featureWhitelist: string[];
  maxCpu: number;
  maxMemoryMb: number;
}): TemplateSpec {
  const t = spec as TemplateSpec;
  const errors: string[] = [];

  if (!t || typeof t !== 'object') {
    throw new DomainError('TEMPLATE_VALIDATION', 'template body must be an object');
  }
  if (!t.name || !NAME_RE.test(t.name)) {
    errors.push('name: must be lowercase alphanumerics and dashes');
  }
  if (!t.image || typeof t.image !== 'string' || t.image.trim() === '') {
    errors.push('image: must be a non-empty string');
  }
  if (!Array.isArray(t.features)) {
    errors.push('features: must be an array');
  } else {
    const unknown = t.features.filter((f) => !limits.featureWhitelist.includes(f));
    if (unknown.length > 0) {
      errors.push('features: unknown features [' + unknown.join(', ') +
        '], whitelist is [' + limits.featureWhitelist.join(', ') + ']');
    }
  }
  if (!t.resources || typeof t.resources !== 'object') {
    errors.push('resources: missing');
  } else {
    const q = t.resources;
    if (typeof q.cpu !== 'number' || q.cpu <= 0) {
      errors.push('resources.cpu: must be a positive number');
    } else if (q.cpu > limits.maxCpu) {
      errors.push('resources.cpu: ' + q.cpu + ' exceeds global limit ' + limits.maxCpu);
    }
    if (typeof q.memoryMb !== 'number' || q.memoryMb <= 0) {
      errors.push('resources.memoryMb: must be a positive number');
    } else if (q.memoryMb > limits.maxMemoryMb) {
      errors.push('resources.memoryMb: ' + q.memoryMb + ' exceeds global limit ' + limits.maxMemoryMb);
    }
  }
  if (typeof t.idleTimeoutMs !== 'number' || t.idleTimeoutMs <= 0) {
    errors.push('idleTimeoutMs: must be a positive number');
  }
  if (errors.length > 0) {
    throw new DomainError('TEMPLATE_VALIDATION', 'invalid template: ' + errors.join('; '), { errors });
  }
  return {
    name: t.name,
    image: t.image.trim(),
    features: [...t.features],
    resources: { ...t.resources },
    idleTimeoutMs: t.idleTimeoutMs,
  };
}

const OVERRIDE_FIELDS = new Set(['cpu', 'memoryMb']);

// Overrides may only shrink the quota relative to the template.
// Unknown fields and values exceeding the template ceiling are rejected
// with the offending field named in the error details.
export function applyOverrides(template: TemplateSpec, overrides: unknown): ResourceQuota {
  if (overrides == null) return { ...template.resources };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new DomainError('OVERRIDE_INVALID', 'overrides must be an object with cpu/memoryMb');
  }
  const result: ResourceQuota = { ...template.resources };
  for (const [key, value] of Object.entries(overrides)) {
    if (!OVERRIDE_FIELDS.has(key)) {
      throw new DomainError('OVERRIDE_INVALID', 'unknown override field ' + JSON.stringify(key), { field: key });
    }
    const limit = template.resources[key as keyof ResourceQuota];
    if (typeof value !== 'number' || value <= 0) {
      throw new DomainError('OVERRIDE_INVALID', 'override ' + key + ': must be a positive number', { field: key, value });
    }
    if (value > limit) {
      throw new DomainError('OVERRIDE_INVALID',
        'override ' + key + ': ' + value + ' exceeds template limit ' + limit,
        { field: key, requested: value, limit });
    }
    result[key as keyof ResourceQuota] = value;
  }
  return result;
}
