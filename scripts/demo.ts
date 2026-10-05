// Local demo: runs the three canonical patterns through kernel + classifier,
// persists to SQLite, and prints the cross-round trend.
import { rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { executeRuns } from '../src/kernel/runner.ts';
import { classify } from '../src/kernel/classifier.ts';
import { executorFor } from '../src/kernel/executors.ts';
import { HistoryStore } from '../src/state/store.ts';
import type { DetectionReport } from '../src/contract/types.ts';

const DB = 'data/demo.db';
rmSync(DB, { force: true });
mkdirSync('data', { recursive: true });
const config = loadConfig();
const store = new HistoryStore(DB);

async function round(testName: string, pattern: string, runs: number): Promise<void> {
  console.log(`\n=== ${testName} pattern=${pattern} runs=${runs} ===`);
  const records = await executeRuns(testName, executorFor(pattern), { runs, maxRuns: config.maxRuns, logger: console.log });
  const result = classify(records.map((r) => r.outcome), { targetReliability: config.targetReliability, maxRetries: config.maxRetries });
  const report: DetectionReport = {
    testName, roundId: randomUUID(), totalRuns: records.length,
    createdAt: new Date().toISOString(), ...result,
  };
  store.saveReport(report, records);
  console.log('report:', JSON.stringify(report, null, 2));
}

await round('demo-pass', 'always-pass', 5);
await round('demo-fail', 'always-fail', 5);
await round('demo-flaky', 'alternate', 6);
await round('demo-flaky', 'alternate', 6); // second round => trend

console.log('\n=== cross-round trend for demo-flaky ===');
console.log(JSON.stringify(store.trend('demo-flaky'), null, 2));
store.close();
