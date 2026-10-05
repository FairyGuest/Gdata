import { InputError } from './errors';
import { FAULT_TYPES, FaultParams, FaultType, ServiceConfig, StartInjectionInput } from './types';

export interface ParseLimits {
  maxDelayMs: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new InputError('field "' + field + '" must be a finite number', { field, received: v });
  }
  return v;
}

export function parseFaultParams(faultType: FaultType, raw: unknown, limits: ParseLimits): FaultParams {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    throw new InputError('field "params" must be an object', { received: raw });
  }
  const obj: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const params: FaultParams = {};
  if (faultType === 'latency') {
    const delayMs = requireNumber(obj, 'delayMs');
    if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > limits.maxDelayMs) {
      throw new InputError('params.delayMs must be an integer in [1, ' + limits.maxDelayMs + ']', {
        field: 'params.delayMs',
        received: delayMs,
      });
    }
    params.delayMs = delayMs;
  }
  if (faultType === 'error_status') {
    const statusCode = obj.statusCode === undefined ? 503 : requireNumber(obj, 'statusCode');
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new InputError('params.statusCode must be an integer in [400, 599]', {
        field: 'params.statusCode',
        received: statusCode,
      });
    }
    params.statusCode = statusCode;
  }
  if (faultType === 'truncate') {
    const keepRatio = obj.keepRatio === undefined ? 0.5 : requireNumber(obj, 'keepRatio');
    if (keepRatio <= 0 || keepRatio >= 1) {
      throw new InputError('params.keepRatio must be in the open interval (0, 1)', {
        field: 'params.keepRatio',
        received: keepRatio,
      });
    }
    params.keepRatio = keepRatio;
  }
  return params;
}

export function parseStartInjection(raw: unknown, limits: ParseLimits): StartInjectionInput {
  if (!isPlainObject(raw)) {
    throw new InputError('request body must be a JSON object', { received: raw });
  }
  const faultType = raw.faultType;
  if (typeof faultType !== 'string' || !FAULT_TYPES.includes(faultType as FaultType)) {
    throw new InputError('field "faultType" must be one of: ' + FAULT_TYPES.join(', '), {
      field: 'faultType',
      received: faultType,
    });
  }
  const probability = requireNumber(raw, 'probability');
  if (probability < 0 || probability > 1) {
    throw new InputError('field "probability" must be in [0, 1]', {
      field: 'probability',
      received: probability,
    });
  }
  let durationMs: number | null = null;
  if (raw.durationMs !== undefined && raw.durationMs !== null && raw.durationMs !== 0) {
    const d = requireNumber(raw, 'durationMs');
    if (!Number.isInteger(d) || d < 1) {
      throw new InputError('field "durationMs" must be a positive integer, 0 or null', {
        field: 'durationMs',
        received: d,
      });
    }
    durationMs = d;
  }
  const params = parseFaultParams(faultType as FaultType, raw.params, limits);
  return { faultType: faultType as FaultType, probability, durationMs, params };
}

export function parseConfig(raw: unknown): ServiceConfig {
  if (!isPlainObject(raw)) {
    throw new InputError('config must be a JSON object');
  }
  const cfg: ServiceConfig = {
    port: raw.port === undefined ? 4700 : requireNumber(raw, 'port'),
    host: typeof raw.host === 'string' ? raw.host : '127.0.0.1',
    targetUrl: typeof raw.targetUrl === 'string' ? raw.targetUrl : '',
    dbPath: typeof raw.dbPath === 'string' ? raw.dbPath : ':memory:',
    maxActiveInjections: raw.maxActiveInjections === undefined ? 16 : requireNumber(raw, 'maxActiveInjections'),
    maxDelayMs: raw.maxDelayMs === undefined ? 60000 : requireNumber(raw, 'maxDelayMs'),
  };
  if (!cfg.targetUrl) throw new InputError('config.targetUrl is required');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new InputError('config.port must be an integer in [1, 65535]', { received: cfg.port });
  }
  try {
    new URL(cfg.targetUrl);
  } catch {
    throw new InputError('config.targetUrl must be a valid URL', { received: cfg.targetUrl });
  }
  if (!Number.isInteger(cfg.maxActiveInjections) || cfg.maxActiveInjections < 1) {
    throw new InputError('config.maxActiveInjections must be a positive integer');
  }
  return cfg;
}