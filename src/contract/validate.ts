// Contract parsing: validates incoming layer structures and request payloads.
import { ServiceError, type JsonObject, type JsonValue, type LayerName, type Layers } from './types.ts';

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validates one layer: must be a plain object, no empty-string keys at any depth.
// On failure throws ServiceError INVALID_LAYER naming the layer and the dot path.
export function validateLayer(layerName: LayerName, value: unknown): JsonObject {
  if (!isPlainObject(value)) {
    throw new ServiceError('INVALID_LAYER', `Layer "${layerName}" must be a plain object`, {
      layer: layerName,
      path: '',
      reason: 'layer is not an object',
    });
  }
  const walk = (obj: JsonObject, path: string): void => {
    for (const [key, val] of Object.entries(obj)) {
      const here = path === '' ? key : path + '.' + key;
      if (key === '') {
        throw new ServiceError('INVALID_LAYER', `Layer "${layerName}" contains an empty key at "${path || '(root)'}"`, {
          layer: layerName,
          path,
          reason: 'empty key',
        });
      }
      if (isPlainObject(val)) walk(val, here);
    }
  };
  walk(value, '');
  return value;
}

export function validateLayers(raw: unknown): Layers {
  if (!isPlainObject(raw)) {
    throw new ServiceError('INVALID_INPUT', 'Field "layers" must be an object with base/env/instance keys');
  }
  const names: LayerName[] = ['base', 'env', 'instance'];
  for (const name of names) {
    if (!(name in raw)) {
      throw new ServiceError('INVALID_INPUT', `Missing layer "${name}" in request`, { layer: name });
    }
  }
  return {
    base: validateLayer('base', raw['base']),
    env: validateLayer('env', raw['env']),
    instance: validateLayer('instance', raw['instance']),
  };
}

export function validateSnapshot(raw: unknown): JsonObject {
  if (!isPlainObject(raw)) {
    throw new ServiceError('INVALID_INPUT', 'Field "snapshot" must be a plain object');
  }
  return raw;
}

export function validateEnvName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ServiceError('INVALID_INPUT', 'Field "env" must be a non-empty string');
  }
  return raw;
}

export function validateEvaluateBody(raw: unknown): { env: string; layers: Layers; snapshot: JsonObject } {
  if (!isPlainObject(raw)) {
    throw new ServiceError('INVALID_INPUT', 'Request body must be a JSON object');
  }
  return {
    env: validateEnvName(raw['env']),
    layers: validateLayers(raw['layers']),
    snapshot: validateSnapshot(raw['snapshot']),
  };
}

export type { JsonValue };
