// Data contracts exchanged between contract layer, kernel, store and HTTP.

export type ParamType = 'string' | 'number' | 'boolean';
export type ParamValue = string | number | boolean;

export interface ParamDecl {
  type: ParamType;
  default: ParamValue;
}

export interface EnvironmentTemplate {
  name: string;
  services: string[];
  params: Record<string, ParamDecl>;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export const EnvStatus = {
  DEPLOYING: 'DEPLOYING',
  ACTIVE: 'ACTIVE',
  RECLAIMED: 'RECLAIMED',
  DELETED: 'DELETED',
} as const;
export type EnvStatus = (typeof EnvStatus)[keyof typeof EnvStatus];

// Statuses that occupy a quota slot and block same-branch creation.
export const OCCUPYING_STATUSES: readonly EnvStatus[] = [EnvStatus.DEPLOYING, EnvStatus.ACTIVE];

export interface Environment {
  id: string;
  branch: string;
  owner: string;
  templateName: string;
  params: Record<string, ParamValue>;
  paramsHash: string;
  status: EnvStatus;
  ttlSeconds: number;
  renewalsUsed: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface CreateRequest {
  owner: string;
  branch: string;
  overrides?: Record<string, unknown>;
  ttlSeconds?: number;
}

export interface CreateResult {
  env: Environment;
  idempotent: boolean;
}

export interface StateTransition {
  envId: string;
  from: EnvStatus | null;
  to: EnvStatus;
  at: number;
  reason: string;
}

export interface AuditEvent {
  seq: number;
  runId: string;
  at: number;
  envId: string | null;
  action: string;
  outcome: 'ALLOW' | 'DENY';
  reason: string;
  details: Record<string, unknown>;
}

