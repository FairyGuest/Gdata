// Pure graph computation: contract parsing/validation, affected-set closure
// and stable topological ordering. No I/O happens here.

import { ContractError } from "../domain/errors.ts";
import type { TargetDefinition } from "../domain/types.ts";

export interface TargetGraph {
  /** name -> definition */
  targets: Map<string, TargetDefinition>;
  /** name -> names of targets that directly depend on it (reverse edges) */
  dependents: Map<string, string[]>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate raw input and build the immutable target graph. */
export function parseTargets(raw: unknown, maxTargets: number): TargetGraph {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { targets?: unknown }).targets)) {
    throw new ContractError("request body must be an object with a 'targets' array");
  }
  const defs = (raw as { targets: unknown[] }).targets;
  if (defs.length === 0) throw new ContractError("'targets' must not be empty");
  if (defs.length > maxTargets) {
    throw new ContractError("target count " + defs.length + " exceeds limit " + maxTargets);
  }
  const targets = new Map<string, TargetDefinition>();
  for (const item of defs) {
    const d = item as Partial<TargetDefinition>;
    if (typeof d !== "object" || d === null) throw new ContractError("each target must be an object");
    if (typeof d.name !== "string" || !NAME_RE.test(d.name)) {
      throw new ContractError("target name must match " + NAME_RE + ", got: " + JSON.stringify(d.name));
    }
    if (targets.has(d.name)) throw new ContractError("duplicate target name: " + d.name);
    if (!Array.isArray(d.watchPaths) || d.watchPaths.some((p) => typeof p !== "string" || p.length === 0)) {
      throw new ContractError("target '" + d.name + "': watchPaths must be a non-empty-string array");
    }
    if (!Array.isArray(d.dependencies) || d.dependencies.some((p) => typeof p !== "string")) {
      throw new ContractError("target '" + d.name + "': dependencies must be a string array");
    }
    targets.set(d.name, { name: d.name, watchPaths: [...d.watchPaths], dependencies: [...d.dependencies] });
  }
  for (const t of targets.values()) {
    for (const dep of t.dependencies) {
      if (!targets.has(dep)) throw new ContractError("target '" + t.name + "' depends on unknown target '" + dep + "'");
      if (dep === t.name) throw new ContractError("target '" + t.name + "' depends on itself");
    }
  }
  const dependents = new Map<string, string[]>();
  for (const t of targets.values()) dependents.set(t.name, []);
  for (const t of targets.values()) {
    for (const dep of t.dependencies) dependents.get(dep)!.push(t.name);
  }
  const graph: TargetGraph = { targets, dependents };
  assertAcyclic(graph);
  return graph;
}

function assertAcyclic(graph: TargetGraph): void {
  // Kahn over the full graph; leftover nodes form a cycle.
  const indeg = new Map<string, number>();
  for (const t of graph.targets.values()) indeg.set(t.name, t.dependencies.length);
  const ready = [...graph.targets.values()].filter((t) => t.dependencies.length === 0).map((t) => t.name);
  let seen = 0;
  while (ready.length > 0) {
    const n = ready.pop()!;
    seen++;
    for (const d of graph.dependents.get(n) ?? []) {
      const left = indeg.get(d)! - 1;
      indeg.set(d, left);
      if (left === 0) ready.push(d);
    }
  }
  if (seen !== graph.targets.size) {
    const cyclic = [...indeg.entries()].filter(([, d]) => d > 0).map(([n]) => n).sort();
    throw new ContractError("dependency cycle detected involving: " + cyclic.join(", "));
  }
}

/**
 * Step 1 of change detection: direct path matches, then step 2: transitive
 * closure along reverse dependency edges (dependents of dependents...).
 */
export function affectedClosure(graph: TargetGraph, changedPaths: string[]): Set<string> {
  const changed = new Set(changedPaths);
  const affected = new Set<string>();
  const stack: string[] = [];
  for (const t of graph.targets.values()) {
    if (t.watchPaths.some((p) => changed.has(p))) {
      affected.add(t.name);
      stack.push(t.name);
    }
  }
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const d of graph.dependents.get(n) ?? []) {
      if (!affected.has(d)) {
        affected.add(d);
        stack.push(d);
      }
    }
  }
  return affected;
}

/**
 * Topological order of the given subset (dependencies first). Ties are broken
 * by target name, lexicographically ascending, so output is stable.
 */
export function topoOrder(graph: TargetGraph, subset: Set<string>): string[] {
  const indeg = new Map<string, number>();
  for (const name of subset) {
    const t = graph.targets.get(name)!;
    indeg.set(name, t.dependencies.filter((d) => subset.has(d)).length);
  }
  const ready = [...subset].filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!; // smallest name first: stable lexicographic tie-break
    order.push(n);
    for (const d of (graph.dependents.get(n) ?? []).filter((x) => subset.has(x))) {
      const left = indeg.get(d)! - 1;
      indeg.set(d, left);
      if (left === 0) {
        // insert keeping 'ready' sorted
        let i = 0;
        while (i < ready.length && ready[i] < d) i++;
        ready.splice(i, 0, d);
      }
    }
  }
  return order;
}

/** Names of targets inside 'subset' that transitively depend on 'upstream'. */
export function downstreamWithin(graph: TargetGraph, upstream: string, subset: Set<string>): string[] {
  const out: string[] = [];
  const stack = [...(graph.dependents.get(upstream) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (subset.has(n)) out.push(n);
    for (const d of graph.dependents.get(n) ?? []) stack.push(d);
  }
  return out;
}
