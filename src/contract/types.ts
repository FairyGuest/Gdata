export interface HealthCheckDesc {
  kind: 'fixture';
  result: 'healthy' | 'failing';
}

export interface ServiceDefinition {
  name: string;
  port: number;
  dependsOn: string[];
  outputs: string[];
  env: Record<string, string>;
  healthCheck: HealthCheckDesc;
}

export interface OrchestrationSpec {
  name: string;
  services: ServiceDefinition[];
}

export interface PortConflict {
  port: number;
  services: string[];
}

export interface MissingEnvRef {
  key: string;
  referencedBy: string[];
}

export interface LayerResult {
  layer: number;
  services: ServiceHealth[];
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'failed' | 'blocked';
}

export interface StartupResult {
  status: 'completed' | 'failed';
  layers: LayerResult[];
  failure?: {
    layer: number;
    services: string[];
    reason: string;
  };
}

export interface ImpactResult {
  changedService: string;
  affected: string[];
  skipped: string[];
}

export interface PlanResult {
  layers: string[][];
  startOrder: string[];
  stopOrder: string[];
}
