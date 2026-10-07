import { VirtualClock } from '../src/kernel/clock.ts';
import { InstanceStore } from '../src/store/sqlite.ts';
import { Provisioner } from '../src/kernel/provisioner.ts';
import type { ServiceConfig } from '../src/config.ts';

export function makeKernel(overrides: Partial<ServiceConfig> = {}) {
  const config: ServiceConfig = {
    port: 0,
    dbPath: ':memory:',
    featureWhitelist: ['git', 'docker', 'node'],
    maxCpu: 8,
    maxMemoryMb: 16384,
    maxConcurrentProvisions: 2,
    maxQueueSize: 4,
    provisionDurationMs: 1000,
    ...overrides,
  };
  const clock = new VirtualClock();
  const store = new InstanceStore(':memory:');
  const kernel = new Provisioner(clock, store, config);
  return { kernel, clock, store, config };
}

export const baseTemplate = {
  name: 'node-dev',
  image: 'registry.local/node:20',
  features: ['git', 'node'],
  resources: { cpu: 4, memoryMb: 8192 },
  idleTimeoutMs: 5000,
};
