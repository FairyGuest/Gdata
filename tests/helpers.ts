import { readFileSync } from 'node:fs';
import type { OrchestrationDef, ServiceDef } from '../src/domain/types.ts';

export function loadFixture(): OrchestrationDef {
  return JSON.parse(readFileSync(new URL('../fixtures/valid-stack.json', import.meta.url), 'utf8')) as OrchestrationDef;
}

export function svc(partial: Partial<ServiceDef> & { name: string }): ServiceDef {
  return {
    ports: [],
    dependsOn: [],
    env: {},
    outputs: [],
    health: { kind: 'fixture', fixture: 'healthy' },
    ...partial,
  };
}
