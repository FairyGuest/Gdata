import type { ServiceDef } from './types.ts';

export interface HealthOutcome {
  healthy: boolean;
  reason: string;
}

export function checkHealth(service: ServiceDef): HealthOutcome {
  const suffix = service.health.detail ? ': ' + service.health.detail : '';
  if (service.health.fixture === 'healthy') {
    return { healthy: true, reason: 'fixture reports healthy' + suffix };
  }
  return { healthy: false, reason: 'fixture reports unhealthy' + suffix };
}
