import { randomUUID } from 'node:crypto';
import { ServiceError } from '../contract/errors.ts';
import type { DetectionReport } from '../contract/types.ts';
import { classify } from '../kernel/classifier.ts';
import { executeRuns } from '../kernel/runner.ts';
import { executorFor } from '../kernel/executors.ts';
import type { HistoryStore } from '../state/store.ts';
import type { ServiceConfig } from '../config.ts';
import type { NodeHttpAdapter } from './http-adapter.ts';

export interface RouteDeps {
  store: HistoryStore;
  config: ServiceConfig;
  logger?: (line: string) => void;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Diagnostic API. Error contract: INPUT_ERROR (bad request payload),
// STATE_CONFLICT (a round for the same test is already running),
// RESOURCE_EXHAUSTED (run budget exceeded), COMPUTATION_FAILED (kernel or
// storage failure), NOT_FOUND (no history for the test).
export function registerRoutes(app: NodeHttpAdapter, deps: RouteDeps): void {
  const log = deps.logger ?? (() => {});
  const inProgress = new Set<string>();

  app.register('GET', '/health', () => ({ status: 200, body: { status: 'ok' } }));

  app.register('POST', '/detections', async (req) => {
    if (!isRecord(req.body)) {
      throw new ServiceError('INPUT_ERROR', 'body must be a JSON object');
    }
    const { testName, pattern } = req.body;
    const runs = req.body.runs ?? deps.config.defaultRuns;
    if (typeof testName !== 'string' || testName.trim() === '') {
      throw new ServiceError('INPUT_ERROR', 'testName must be a non-empty string');
    }
    if (typeof pattern !== 'string') {
      throw new ServiceError('INPUT_ERROR', 'pattern must be one of the known executor patterns');
    }
    if (inProgress.has(testName)) {
      throw new ServiceError('STATE_CONFLICT', `a detection round for '${testName}' is already running`);
    }
    inProgress.add(testName);
    try {
      log(`[api] start detection test=${testName} pattern=${pattern} runs=${String(runs)}`);
      const executor = executorFor(pattern);
      const records = await executeRuns(testName, executor, {
        runs: runs as number,
        maxRuns: deps.config.maxRuns,
        logger: log,
      });
      const result = classify(records.map((r) => r.outcome), {
        targetReliability: deps.config.targetReliability,
        maxRetries: deps.config.maxRetries,
      });
      log(`[api] classified test=${testName} as ${result.classification} confidence=${result.confidence} reason="${result.reasoning}"`);
      const report: DetectionReport = {
        testName,
        roundId: randomUUID(),
        totalRuns: records.length,
        createdAt: new Date().toISOString(),
        ...result,
      };
      deps.store.saveReport(report, records);
      return { status: 200, body: { report, runs: records } };
    } finally {
      inProgress.delete(testName);
    }
  });

  app.register('GET', '/reports/:testName', (req) => {
    const found = deps.store.latestRound(req.params.testName!);
    if (!found) {
      throw new ServiceError('NOT_FOUND', `no detection history for '${req.params.testName}'`);
    }
    return { status: 200, body: found };
  });

  app.register('GET', '/reports/:testName/trend', (req) => {
    const entries = deps.store.trend(req.params.testName!);
    if (entries.length === 0) {
      throw new ServiceError('NOT_FOUND', `no detection history for '${req.params.testName}'`);
    }
    const flakyRounds = entries.filter((e) => e.classification === 'flaky').length;
    return {
      status: 200,
      body: { testName: req.params.testName, rounds: entries.length, flakyRounds, entries },
    };
  });
}
