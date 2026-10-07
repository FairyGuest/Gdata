export type HealthFixture = 'healthy' | 'unhealthy';

export interface HealthCheckSpec {
  kind: 'fixture';
  fixture: HealthFixture;
  detail?: string;
}

export interface ServiceDef {
  name: string;
  ports: number[];
  dependsOn: string[];
  env: Record<string, string>;
  outputs: string[];
  health: HealthCheckSpec;
}

export interface OrchestrationDef {
  name: string;
  services: ServiceDef[];
}

export interface LayeredPlan {
  layers: string[][];
  startOrder: string[];
  stopOrder: string[];
}

export interface ImpactResult {
  changed: string;
  affected: string[];
  skipped: string[];
}

export interface LayerFailure {
  service: string;
  reason: string;
}

export interface ExecutionResult {
  status: 'SUCCEEDED' | 'FAILED';
  failedLayer: number | null;
  failures: LayerFailure[];
  completedLayers: string[][];
  startedServices: string[];
}
