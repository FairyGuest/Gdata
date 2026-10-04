// 执行内核编排：解析 -> 建图 -> 匹配 -> 报告，全程写诊断日志。
import { randomUUID } from 'node:crypto';
import { ScanError } from '../contract/errors.ts';
import type { ScanReport, ScanRequest } from '../contract/types.ts';
import { resolveGraph } from './graph.ts';
import { matchVulnerabilities } from './matcher.ts';
import { isValidSemver } from './semver.ts';
import type { Store } from '../state/store.ts';
import { RunLogger } from '../diagnostics/logger.ts';
import type { AppConfig } from '../config.ts';

export function validateRequest(req: unknown): ScanRequest {
  const r = req as ScanRequest;
  if (!r || typeof r !== 'object') throw new ScanError('INPUT_ERROR', 'request body must be an object');
  if (!Array.isArray(r.roots) || r.roots.length === 0) throw new ScanError('INPUT_ERROR', 'roots must be a non-empty array of "name@range"');
  if (!Array.isArray(r.registry) || r.registry.length === 0) throw new ScanError('INPUT_ERROR', 'registry must be a non-empty array of packages');
  for (const p of r.registry) {
    if (!p?.name || typeof p.name !== 'string') throw new ScanError('INPUT_ERROR', 'registry entry missing name');
    if (!isValidSemver(String(p.version ?? ''))) throw new ScanError('INPUT_ERROR', `registry entry "${p.name}" has invalid version "${p.version}"`);
  }
  return r;
}

export function runScan(rawReq: unknown, store: Store, config: AppConfig): ScanReport {
  const logger = new RunLogger(config.logDir, undefined, (e) => store.saveLogEvent(e));
  const runId = logger.runId;
  let scanId;
  logger.info('scan.received', { note: 'validating request contract' });
  try {
    const req = validateRequest(rawReq);
    scanId = req.scanId ?? randomUUID();
    const maxNodes = req.options?.maxNodes ?? config.maxNodes;
    const maxDepth = req.options?.maxDepth ?? config.maxDepth;
    const maxPaths = req.options?.maxPaths ?? config.maxPaths;

    store.createScanRecord(scanId, runId, JSON.stringify(req));
    logger.info('scan.start', { scanId, roots: req.roots, registrySize: req.registry.length, limits: { maxNodes, maxDepth } });

    const graph = resolveGraph(req.registry, req.roots, { maxNodes, maxDepth });
    logger.info('graph.resolved', {
      nodeCount: graph.nodes.size,
      edgeCount: [...graph.edges.values()].reduce((n, e) => n + e.length, 0),
      reason: 'highest satisfying version selected per dependency range',
    });
    for (const c of graph.cycles) {
      logger.warn('cycle.detected', { ...c, reason: 'cycle edge recorded, not expanded' });
    }

    const vulns = store.listVulnerabilities();
    const rootKeys = req.roots.map((root) => {
      // 根节点 key：在图中找 name 匹配且版本满足 range 的节点
      const at = root.indexOf('@');
      const name = root.slice(0, at);
      const hit = [...graph.nodes.keys()].filter((k) => k.startsWith(name + '@'));
      if (hit.length === 0) throw new ScanError('COMPUTATION_FAILURE', `root "${root}" missing from resolved graph`);
      return hit[0];
    });
    const findings = matchVulnerabilities(graph, rootKeys, vulns, maxPaths, maxDepth);
    for (const f of findings) {
      logger.info('match.found', {
        vulnId: f.vulnerability.id, package: `${f.packageName}@${f.packageVersion}`,
        severity: f.vulnerability.severity,
        reason: `version ${f.packageVersion} satisfies affected range "${f.vulnerability.affectedRange}"`,
      });
    }

    const report: ScanReport = {
      scanId, runId, roots: req.roots,
      packageCount: graph.nodes.size, cycles: graph.cycles, findings,
    };
    store.finishScanRecord(scanId, 'COMPLETED', report);
    logger.info('scan.complete', { scanId, packageCount: report.packageCount, findingCount: findings.length, cycleCount: graph.cycles.length });
    return report;
  } catch (err) {
    const category = err instanceof ScanError ? err.category : 'COMPUTATION_FAILURE';
    logger.error('scan.failed', { category, message: err instanceof Error ? err.message : String(err) });
    if (scanId !== undefined) { try { store.finishScanRecord(scanId, 'FAILED'); } catch {} }
    throw err;
  }
}
