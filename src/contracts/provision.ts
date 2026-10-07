import { unknownParameter, limitExceeded, validationError } from '../errors.ts';
import type { TemplateInput } from './template.ts';

export interface ProvisionRequest {
  envName: string;
  templateName: string;
  overrides: { cpu?: number; memoryMb?: number };
}

const ALLOWED_OVERRIDES = new Set(['cpu', 'memoryMb']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a provision request. Overrides may only lower resource quotas relative
 * to the template; unknown parameters and upward adjustments are rejected with
 * the offending field named.
 */
export function parseProvisionRequest(body: unknown, template: TemplateInput): ProvisionRequest {
  if (!isRecord(body)) throw validationError('provision body must be a JSON object');
  const { envName, templateName, overrides } = body;

  if (typeof envName !== 'string' || envName.trim() === '') throw validationError('envName must be a non-empty string', 'envName');
  if (typeof templateName !== 'string' || templateName.trim() === '') throw validationError('templateName must be a non-empty string', 'templateName');
  if (templateName.trim() !== template.name) throw validationError('templateName does not match path template', 'templateName');

  const result: { cpu?: number; memoryMb?: number } = {};
  if (overrides !== undefined) {
    if (!isRecord(overrides)) throw validationError('overrides must be a JSON object', 'overrides');
    for (const key of Object.keys(overrides)) {
      if (!ALLOWED_OVERRIDES.has(key)) throw unknownParameter('overrides.' + key);
    }
    if (overrides.cpu !== undefined) {
      if (typeof overrides.cpu !== 'number' || !Number.isFinite(overrides.cpu) || overrides.cpu <= 0) {
        throw validationError('overrides.cpu must be a positive number', 'overrides.cpu');
      }
      if (overrides.cpu > template.cpu) {
        throw limitExceeded('overrides.cpu ' + overrides.cpu + ' exceeds template limit ' + template.cpu, 'overrides.cpu');
      }
      result.cpu = overrides.cpu;
    }
    if (overrides.memoryMb !== undefined) {
      if (typeof overrides.memoryMb !== 'number' || !Number.isFinite(overrides.memoryMb) || overrides.memoryMb <= 0) {
        throw validationError('overrides.memoryMb must be a positive number', 'overrides.memoryMb');
      }
      if (overrides.memoryMb > template.memoryMb) {
        throw limitExceeded('overrides.memoryMb ' + overrides.memoryMb + ' exceeds template limit ' + template.memoryMb, 'overrides.memoryMb');
      }
      result.memoryMb = overrides.memoryMb;
    }
  }

  return { envName: envName.trim(), templateName: templateName.trim(), overrides: result };
}
