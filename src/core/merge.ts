// Execution kernel: layered merge semantics.
// - scalars: later layer wins
// - plain objects: deep merge down to leaves
// - arrays: wholesale replacement, never element-wise merge
// - null: deletion marker, key is removed from the result
import { isPlainObject } from '../contract/validate.ts';
import type { JsonObject, JsonValue, Layers, MergeStepLog } from '../contract/types.ts';

function mergeInto(target: JsonObject, overlay: JsonObject, stats: { applied: number; deleted: number }): void {
  for (const [key, val] of Object.entries(overlay)) {
    if (val === null) {
      if (key in target) stats.deleted += 1;
      delete target[key];
      continue;
    }
    const existing = target[key];
    if (isPlainObject(val) && isPlainObject(existing)) {
      stats.applied += 1;
      mergeInto(existing, val, stats);
      continue;
    }
    // scalars overwrite, arrays replace wholesale, objects replace non-objects
    target[key] = deepCopy(val);
    stats.applied += 1;
  }
}

function deepCopy(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v);
    return out;
  }
  return value;
}

export function mergeLayers(layers: Layers): { effective: JsonObject; mergeLog: MergeStepLog[] } {
  const effective: JsonObject = {};
  const mergeLog: MergeStepLog[] = [];
  const order: Array<['base' | 'env' | 'instance', JsonObject]> = [
    ['base', layers.base],
    ['env', layers.env],
    ['instance', layers.instance],
  ];
  for (const [name, layer] of order) {
    const stats = { applied: 0, deleted: 0 };
    mergeInto(effective, layer, stats);
    mergeLog.push({
      layer: name,
      appliedKeys: stats.applied,
      deletedKeys: stats.deleted,
      note: `layer "${name}": applied ${stats.applied} key(s), deleted ${stats.deleted} key(s)`,
    });
  }
  return { effective, mergeLog };
}
