// Dependency graph resolution: expands the full transitive closure from the
// root, records cycle edges without expanding them, and enforces resource
// limits (node count / depth) as RESOURCE_EXHAUSTED failures.
import { ScanError } from '../contract/errors.ts';
import type { PackageSpec } from '../contract/schema.ts';

export interface GraphNode {
  ref: string; // "name@version"
  name: string;
  version: string;
  dependencies: string[]; // child refs
}

export interface CycleEdge {
  from: string;
  to: string;
}

export interface ResolvedGraph {
  nodes: Map<string, GraphNode>;
  cycles: CycleEdge[];
  paths: Map<string, string[]>; // ref -> shortest dependency path from root (inclusive)
  maxDepthReached: number;
}

export interface GraphLimits {
  maxPackages: number;
  maxDepth: number;
}

export function resolveGraph(
  packages: PackageSpec[],
  rootRef: string,
  limits: GraphLimits,
  log: (step: string, detail: string) => void = () => {},
): ResolvedGraph {
  const index = new Map<string, PackageSpec>();
  for (const p of packages) index.set(p.name + '@' + p.version, p);

  const nodes = new Map<string, GraphNode>();
  const cycles: CycleEdge[] = [];
  const paths = new Map<string, string[]>();
  let maxDepthReached = 0;

  // BFS from the root; a node's children are expanded once (first visit wins,
  // which also yields the shortest dependency path for the report).
  const queue: Array<{ ref: string; path: string[] }> = [{ ref: rootRef, path: [rootRef] }];
  while (queue.length > 0) {
    const { ref, path } = queue.shift()!;
    if (nodes.has(ref)) continue;
    const spec = index.get(ref);
    if (!spec) {
      throw new ScanError('INPUT_ERROR', 'Dependency "' + ref + '" referenced but not present in "packages"');
    }
    const depth = path.length - 1;
    maxDepthReached = Math.max(maxDepthReached, depth);
    if (depth > limits.maxDepth) {
      throw new ScanError('RESOURCE_EXHAUSTED',
        'Dependency depth ' + depth + ' exceeds maxDepth ' + limits.maxDepth,
        { at: ref, path });
    }
    if (nodes.size >= limits.maxPackages) {
      throw new ScanError('RESOURCE_EXHAUSTED',
        'Package count exceeds maxPackages ' + limits.maxPackages,
        { at: ref });
    }
    const childRefs = Object.entries(spec.dependencies).map(([n, v]) => n + '@' + v);
    nodes.set(ref, { ref, name: spec.name, version: spec.version, dependencies: childRefs });
    paths.set(ref, path);
    log('expand', ref + ' depth=' + depth + ' deps=[' + childRefs.join(', ') + ']');
    for (const child of childRefs) {
      if (path.includes(child)) {
        // Cycle edge: recorded, not expanded.
        cycles.push({ from: ref, to: child });
        log('cycle', 'edge ' + ref + ' -> ' + child + ' recorded, not expanded');
        continue;
      }
      if (!nodes.has(child)) queue.push({ ref: child, path: [...path, child] });
    }
  }
  log('graph', 'resolved nodes=' + nodes.size + ' cycles=' + cycles.length + ' maxDepth=' + maxDepthReached);
  return { nodes, cycles, paths, maxDepthReached };
}
