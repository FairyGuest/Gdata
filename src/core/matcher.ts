// Vulnerability matching: every node in the resolved graph (direct AND
// transitive) is matched against the vulnerability database by package name
// and semver range. Findings are sorted by severity, then vuln id.
import { satisfiesRange } from './semver.ts';
import type { ResolvedGraph } from './graph.ts';

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export interface VulnEntry {
  id: string;
  package: string;
  range: string;
  severity: Severity;
  summary: string;
}

export interface Finding {
  vulnId: string;
  package: string;
  version: string;
  severity: Severity;
  summary: string;
  dependencyPath: string[]; // root -> ... -> vulnerable package
}

function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export function matchVulnerabilities(
  graph: ResolvedGraph,
  vulns: VulnEntry[],
  log: (step: string, detail: string) => void = () => {},
): Finding[] {
  const findings: Finding[] = [];
  for (const node of graph.nodes.values()) {
    for (const v of vulns) {
      if (v.package !== node.name) continue;
      const hit = satisfiesRange(node.version, v.range);
      log('match', node.ref + ' vs ' + v.id + ' (' + v.range + ') => ' + (hit ? 'HIT' : 'miss'));
      if (hit) {
        findings.push({
          vulnId: v.id,
          package: node.name,
          version: node.version,
          severity: v.severity,
          summary: v.summary,
          dependencyPath: graph.paths.get(node.ref) ?? [node.ref],
        });
      }
    }
  }
  findings.sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    a.vulnId.localeCompare(b.vulnId) ||
    a.package.localeCompare(b.package));
  log('report', 'findings=' + findings.length +
    ' bySeverity=' + SEVERITY_ORDER.map((s) => s + ':' + findings.filter((f) => f.severity === s).length).join(','));
  return findings;
}
