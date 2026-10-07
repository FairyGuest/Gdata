/** Dependency graph math: transitive closure + stable topological order. */

import { computationError, inputError } from '../domain/errors.ts';
import type { TargetDefinition } from '../domain/types.ts';

export interface TargetGraph {
  /** name -> definition */
  targets: Map<string, TargetDefinition>;
  /** name -> names of targets that directly depend on it (reverse edges) */
  dependents: Map<string, Set<string>>;
}

export function buildGraph(defs: TargetDefinition[]): TargetGraph {
  const targets = new Map<string, TargetDefinition>();
  for (const def of defs) {
    if (!def.name || typeof def.name !== 'string') {
      throw inputError('target name must be a non-empty string', { def });
    }
    if (targets.has(def.name)) {
      throw inputError(`duplicate target name: ${def.name}`);
    }
    if (!Array.isArray(def.paths) || !Array.isArray(def.deps)) {
      throw inputError(`target ${def.name}: paths and deps must be arrays`);
    }
    targets.set(def.name, { name: def.name, paths: [...def.paths], deps: [...def.deps] });
  }
  const dependents = new Map<string, Set<string>>();
  for (const name of targets.keys()) dependents.set(name, new Set());
  for (const def of targets.values()) {
    for (const dep of def.deps) {
      if (!targets.has(dep)) {
        throw inputError(`target ${def.name} depends on unknown target: ${dep}`);
      }
      dependents.get(dep)!.add(def.name);
    }
  }
  const graph = { targets, dependents };
  // Reject cycles at registration time so runs never hit them mid-flight.
  topoOrder(graph, [...targets.keys()]);
  return graph;
}

/**
 * Step 1: direct hits by exact watched-path match.
 * Step 2: transitive closure along dependency edges (everything downstream).
 */
export function computeAffected(graph: TargetGraph, changedPaths: string[]): {
  direct: string[];
  affected: string[];
} {
  const changed = new Set(changedPaths);
  const direct: string[] = [];
  for (const def of graph.targets.values()) {
    if (def.paths.some((p) => changed.has(p))) direct.push(def.name);
  }
  direct.sort();
  const affected = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of graph.dependents.get(cur) ?? []) {
      if (!affected.has(next)) {
        affected.add(next);
        queue.push(next);
      }
    }
  }
  return { direct, affected: [...affected].sort() };
}

/**
 * Kahn's algorithm over the given subset; ties broken by target name
 * (lexicographic) so the order is deterministic.
 */
export function topoOrder(graph: TargetGraph, subset: string[]): string[] {
  const inSubset = new Set(subset);
  const indegree = new Map<string, number>();
  for (const name of subset) {
    const def = graph.targets.get(name);
    if (!def) throw computationError(`topoOrder: unknown target ${name}`);
    let deg = 0;
    for (const dep of def.deps) if (inSubset.has(dep)) deg++;
    indegree.set(name, deg);
  }
  const ready = subset.filter((n) => indegree.get(n) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const cur = ready.shift()!;
    order.push(cur);
    for (const next of graph.dependents.get(cur) ?? []) {
      if (!inSubset.has(next)) continue;
      const deg = indegree.get(next)! - 1;
      indegree.set(next, deg);
      if (deg === 0) {
        // insert keeping lexicographic order
        let i = 0;
        while (i < ready.length && ready[i] < next) i++;
        ready.splice(i, 0, next);
      }
    }
  }
  if (order.length !== subset.length) {
    const remaining = subset.filter((n) => !order.includes(n));
    throw computationError('dependency cycle detected', { remaining });
  }
  return order;
}