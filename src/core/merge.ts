// Merge kernel: layered cascade merge with explicit semantics.
//
//   - scalar keys: later layer wins
//   - objects: deep merge (recurse to leaves)
//   - arrays: replaced wholesale, never element-merged
//   - null: deletion marker, removes the key from the result
//
// Structural validation rejects non-object layers and empty-string keys,
// reporting the layer name and the dot-path position of the violation.

import { AppError } from "../contracts/errors.ts";
import { LAYER_NAMES } from "../contracts/types.ts";
import type { JsonObject, JsonValue, LayerName, LayerSet } from "../contracts/types.ts";

export const MERGE_LIMITS = {
  maxDepth: 64,
  maxKeys: 10000,
} as const;

export function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateKeys(node: JsonValue, layer: LayerName, path: string, depth: number): void {
  if (depth > MERGE_LIMITS.maxDepth) {
    throw new AppError("RESOURCE_EXHAUSTED", `layer "${layer}" exceeds max depth ${MERGE_LIMITS.maxDepth} at "${path || "<root>"}"`, {
      layer, path,
    });
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    if (key === "") {
      throw new AppError("INPUT_ERROR", `layer "${layer}" contains an empty-string key at "${path || "<root>"}"`, {
        layer, path, reason: "empty_key",
      });
    }
    const childPath = path === "" ? key : `${path}.${key}`;
    validateKeys(node[key]!, layer, childPath, depth + 1);
  }
}

export function validateLayer(layer: LayerName, value: JsonValue): JsonObject {
  if (!isPlainObject(value)) {
    throw new AppError("INPUT_ERROR", `layer "${layer}" must be a JSON object, got ${Array.isArray(value) ? "array" : JSON.stringify(value)}`, {
      layer, path: "", reason: "layer_not_object",
    });
  }
  validateKeys(value, layer, "", 1);
  return value;
}

function mergeTwo(lower: JsonValue, upper: JsonValue, layer: LayerName, path: string, depth: number): JsonValue {
  if (depth > MERGE_LIMITS.maxDepth) {
    throw new AppError("RESOURCE_EXHAUSTED", `merge exceeds max depth ${MERGE_LIMITS.maxDepth} at "${path || "<root>"}"`, {
      layer, path,
    });
  }
  if (upper === null) return undefined as unknown as JsonValue; // deletion marker
  if (isPlainObject(lower) && isPlainObject(upper)) {
    const out: JsonObject = {};
    for (const key of Object.keys(lower)) out[key] = lower[key]!;
    for (const key of Object.keys(upper)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const merged = mergeTwo(out[key] as JsonValue, upper[key]!, layer, childPath, depth + 1);
      if (merged === undefined) delete out[key];
      else out[key] = merged;
    }
    return out;
  }
  // scalars overwrite, arrays replace wholesale, type changes overwrite
  return upper;
}

export interface MergeTrace {
  layer: LayerName;
  keysAfterMerge: number;
}

export interface MergeResult {
  effective: JsonObject;
  trace: MergeTrace[];
}

export function mergeLayers(layers: LayerSet): MergeResult {
  let acc: JsonValue = {};
  const trace: MergeTrace[] = [];
  for (const name of LAYER_NAMES) {
    const validated = validateLayer(name, layers[name]);
    acc = mergeTwo(acc, validated, name, "", 1);
    const keyCount = countKeys(acc);
    if (keyCount > MERGE_LIMITS.maxKeys) {
      throw new AppError("RESOURCE_EXHAUSTED", `merged config exceeds max key count ${MERGE_LIMITS.maxKeys} after layer "${name}"`, {
        layer: name, keys: keyCount,
      });
    }
    trace.push({ layer: name, keysAfterMerge: keyCount });
  }
  return { effective: acc as JsonObject, trace };
}

function countKeys(node: JsonValue): number {
  if (!isPlainObject(node)) return 0;
  let n = 0;
  for (const key of Object.keys(node)) n += 1 + countKeys(node[key]!);
  return n;
}
