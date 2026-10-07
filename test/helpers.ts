import { VirtualClock } from '../src/clock.ts';
import { openDb } from '../src/state/db.ts';
import { Store } from '../src/state/store.ts';
import { TemplateRegistry } from '../src/core/registry.ts';
import { Provisioner } from '../src/core/provisioner.ts';
import type { ServiceConfig } from '../src/config.ts';

export const T0 = 1_000_000;

export function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    maxCpu: 8,
    maxMemoryMb: 16384,
    featureWhitelist: ['node', 'python', 'docker-in-docker'],
    maxConcurrentProvisions: 2,
    provisionDurationMs: 5000,
    dbPath: ':memory:',
    port: 0,
    ...overrides,
  };
}

export function makeStack(cfg: ServiceConfig = makeConfig()) {
  const clock = new VirtualClock(T0);
  const store = new Store(openDb(':memory:'));
  const registry = new TemplateRegistry(store, clock, cfg);
  const provisioner = new Provisioner(store, clock, cfg);
  return { clock, store, registry, provisioner, cfg };
}

export const baseTemplate = {
  name: 'node-dev',
  image: 'registry.local/node:20',
  features: ['node', 'docker-in-docker'],
  cpu: 4,
  memoryMb: 8192,
  idleTimeoutMs: 10000,
};
