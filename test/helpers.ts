import { EnvironmentStore } from '../src/store/sqliteStore.ts';
import { LifecycleKernel } from '../src/core/lifecycle.ts';
import { VirtualClock } from '../src/clock.ts';
import { RunLogger, MemorySink } from '../src/logger.ts';
import { parseTemplate } from '../src/contract/template.ts';
import { readFileSync } from 'node:fs';

export function makeKernel(opts: { quotaPerOwner?: number; deploySeconds?: number } = {}) {
  const template = parseTemplate(JSON.parse(readFileSync('fixtures/template.json', 'utf8')));
  const store = new EnvironmentStore(':memory:');
  const clock = new VirtualClock(1_760_000_000_000);
  const sink = new MemorySink();
  const logger = new RunLogger(sink);
  const kernel = new LifecycleKernel(store, template, clock, {
    quotaPerOwner: opts.quotaPerOwner ?? 2,
    deploySeconds: opts.deploySeconds ?? 30,
  }, logger);
  return { kernel, store, clock, sink, template };
}
