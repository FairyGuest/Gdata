// Execution kernel: orchestrates contract -> graph -> match -> persist,
// emitting structured run-log events (run id, intermediate state, rationale)
// so any run can be replayed from the diagnostics endpoint.
import { createHash, randomUUID } from 'node:crypto';
import { parseScanRequest } from '../contract/schema.ts';
import { ScanError, toScanError } from '../contract/errors.ts';
import { resolveGraph } from './graph.ts';
import { matchVulnerabilities } from './matcher.ts';
import type { ScannerConfig } from '../config.ts';
import type { Store } from '../state/store.ts';

export interface ScanReport {
  runId: string;
  status: 'completed' | 'failed';
  root: string;
  stats: { packagesScanned: number; cyclesDetected: number; maxDepth: number };
  cycles: Array<{ from: string; to: string }>;
  findings: Array<{
    vulnId: string; package: string; version: string;
    severity: string; summary: string; dependencyPath: string[];
  }>;
  error?: { category: string; message: string };
}

export function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export class ScanEngine {
  private readonly store: Store;
  private readonly config: Pick<ScannerConfig, 'maxPackages' | 'maxDepth'>;

  constructor(store: Store, config: Pick<ScannerConfig, 'maxPackages' | 'maxDepth'>) {
    this.store = store;
    this.config = config;
  }

  run(rawBody: unknown): ScanReport {
    const runId = 'run-' + randomUUID();
    const log = (step: string, detail: string) =>
      this.store.appendLog(runId, step, detail);
    try {
      log('contract', 'validating scan request');
      const req = parseScanRequest(rawBody);
      const fp = fingerprint(rawBody);

      if (req.idempotencyKey) {
        const existing = this.store.findByIdempotencyKey(req.idempotencyKey);
        if (existing) {
          if (existing.request_fingerprint !== fp) {
            log('idempotency', 'key "' + req.idempotencyKey + '" reused with different payload => STATE_CONFLICT');
            throw new ScanError('STATE_CONFLICT',
              'idempotencyKey "' + req.idempotencyKey + '" was already used with a different payload',
              { runId, originalRunId: existing.run_id });
          }
          log('idempotency', 'key "' + req.idempotencyKey + '" replayed with identical payload => returning stored run ' + existing.run_id);
          return JSON.parse(existing.report_json) as ScanReport;
        }
      }

      log('graph', 'resolving transitive dependency graph from root ' + req.root);
      const graph = resolveGraph(req.packages, req.root, this.config, log);
      log('match', 'matching ' + graph.nodes.size + ' packages against vulnerability database');
      const findings = matchVulnerabilities(graph, this.store.listVulns(), log);

      const report: ScanReport = {
        runId,
        status: 'completed',
        root: req.root,
        stats: {
          packagesScanned: graph.nodes.size,
          cyclesDetected: graph.cycles.length,
          maxDepth: graph.maxDepthReached,
        },
        cycles: graph.cycles,
        findings,
      };
      this.store.saveRun(runId, req.idempotencyKey ?? null, fp, 'completed', report);
      log('done', 'run ' + runId + ' completed: ' + findings.length + ' findings');
      return report;
    } catch (err) {
      const scanErr = toScanError(err);
      log('error', scanErr.category + ': ' + scanErr.message);
      this.store.saveRun(runId, null, fingerprint(rawBody), 'failed', {
        runId, status: 'failed', root: '',
        stats: { packagesScanned: 0, cyclesDetected: 0, maxDepth: 0 },
        cycles: [], findings: [],
        error: { category: scanErr.category, message: scanErr.message },
      });
      throw new ScanError(scanErr.category, scanErr.message,
        { runId, cause: scanErr.detail ?? null });
    }
  }
}
