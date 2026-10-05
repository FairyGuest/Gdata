import { randomUUID } from 'node:crypto';
import { CaseResult, RunStatus, RunSummary } from './contracts';

/** 汇总报告层：把逐用例结果聚合为一次运行的总结。 */
export function buildSummary(
  startedAt: Date,
  results: CaseResult[],
  logs: string[],
): RunSummary {
  const finishedAt = new Date();
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const timeout = results.filter((r) => r.status === 'timeout').length;
  let status: RunStatus = 'passed';
  if (failed + timeout > 0 && passed > 0) status = 'partial';
  else if (failed + timeout > 0) status = 'failed';
  return {
    runId: randomUUID(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    total: results.length,
    passed,
    failed,
    timeout,
    status,
    results,
    logs,
  };
}