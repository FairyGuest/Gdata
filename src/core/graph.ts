// 依赖图解析：从根包出发解析完整传递依赖图。
// 循环边记录但不展开；节点数/深度超限报 RESOURCE_EXHAUSTED。
import { ScanError } from '../contract/errors.ts';
import type { PackageSpec, ResolvedGraph, ScanOptions } from '../contract/types.ts';
import { compareVersions, isValidSemver, satisfies } from './semver.ts';

export function resolveGraph(
  registry: PackageSpec[],
  roots: string[],
  options: Required<Pick<ScanOptions, 'maxNodes' | 'maxDepth'>>,
): ResolvedGraph {
  const byName = new Map<string, PackageSpec[]>();
  for (const p of registry) {
    if (!p.name || !isValidSemver(p.version ?? '')) {
      throw new ScanError('INPUT_ERROR', `registry entry has invalid name/version: ${JSON.stringify(p)}`);
    }
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }
  for (const list of byName.values()) list.sort((a, b) => compareVersions(b.version, a.version));

  const nodes = new Map<string, PackageSpec>();
  const edges = new Map<string, string[]>();
  const cycles: { from: string; to: string }[] = [];

  const pick = (name: string, range: string): PackageSpec => {
    const candidates = byName.get(name);
    if (!candidates) throw new ScanError('INPUT_ERROR', `dependency "${name}" not found in registry`);
    const hit = candidates.find((c) => satisfies(c.version, range));
    if (!hit) throw new ScanError('INPUT_ERROR', `no version of "${name}" satisfies range "${range}"`);
    return hit;
  };

  const parseRoot = (root: string): { name: string; range: string } => {
    const at = root.indexOf('@');
    if (at <= 0) throw new ScanError('INPUT_ERROR', `invalid root spec "${root}" (expected name@range)`);
    return { name: root.slice(0, at), range: root.slice(at + 1) };
  };

  // DFS 展开；stack 记录当前展开路径用于循环检测。
  const stack: string[] = [];
  const expand = (pkg: PackageSpec, depth: number): void => {
    if (depth > options.maxDepth) {
      throw new ScanError('RESOURCE_EXHAUSTED', `dependency depth exceeds limit ${options.maxDepth}`, { at: pkg.name });
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (edges.has(key)) return; // 已展开过（共享子图）
    if (nodes.size >= options.maxNodes) {
      throw new ScanError('RESOURCE_EXHAUSTED', `dependency graph exceeds node limit ${options.maxNodes}`);
    }
    nodes.set(key, pkg);
    edges.set(key, []);
    stack.push(key);
    for (const [depName, depRange] of Object.entries(pkg.dependencies ?? {})) {
      const dep = pick(depName, depRange);
      const depKey = `${dep.name}@${dep.version}`;
      if (stack.includes(depKey)) {
        // 循环边：记录但不展开、不加入邻接表
        cycles.push({ from: key, to: depKey });
        continue;
      }
      edges.get(key)!.push(depKey);
      expand(dep, depth + 1);
    }
    stack.pop();
  };

  for (const root of roots) {
    const { name, range } = parseRoot(root);
    expand(pick(name, range), 0);
  }
  return { nodes, edges, cycles, truncated: false };
}

// 从根到目标节点的简单路径（DFS，带深度与数量上限；图可能有环，用 visited 防死循环）。
export function findPaths(
  graph: ResolvedGraph,
  rootKeys: string[],
  target: string,
  maxPaths: number,
  maxDepth: number,
): string[][] {
  const paths: string[][] = [];
  const visit = (node: string, trail: string[], seen: Set<string>): void => {
    if (paths.length >= maxPaths || trail.length > maxDepth + 1) return;
    if (node === target) { paths.push([...trail, node]); return; }
    seen.add(node);
    for (const next of graph.edges.get(node) ?? []) {
      if (!seen.has(next)) visit(next, [...trail, node], seen);
    }
    seen.delete(node);
  };
  for (const root of rootKeys) {
    if (paths.length >= maxPaths) break;
    visit(root, [], new Set());
  }
  return paths;
}
