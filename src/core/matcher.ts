// 漏洞匹配：图中所有节点（含传递依赖）与漏洞库按包名 + 版本范围匹配。
import type { Vulnerability, Finding, ResolvedGraph } from '../contract/types.ts';
import { SEVERITY_ORDER } from '../contract/types.ts';
import { satisfies } from './semver.ts';
import { findPaths } from './graph.ts';

export function matchVulnerabilities(
  graph: ResolvedGraph,
  rootKeys: string[],
  vulns: Vulnerability[],
  maxPaths: number,
  maxDepth: number,
): Finding[] {
  const findings: Finding[] = [];
  for (const [key, pkg] of graph.nodes) {
    for (const v of vulns) {
      if (v.packageName !== pkg.name) continue;
      if (!satisfies(pkg.version, v.affectedRange)) continue;
      findings.push({
        vulnerability: v,
        packageName: pkg.name,
        packageVersion: pkg.version,
        paths: findPaths(graph, rootKeys, key, maxPaths, maxDepth),
      });
    }
  }
  findings.sort((a, b) => {
    const d = SEVERITY_ORDER[a.vulnerability.severity] - SEVERITY_ORDER[b.vulnerability.severity];
    return d !== 0 ? d : a.vulnerability.id.localeCompare(b.vulnerability.id);
  });
  return findings;
}
