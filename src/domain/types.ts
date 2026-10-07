export type ScopeType = "org" | "project" | "env";
export const SCOPE_ORDER: ScopeType[] = ["org", "project", "env"];

export interface SecretDeclaration {
  id: string;
  scopeType: ScopeType;
  scopeId: string;
  name: string;
  value: string;
  version: number;
  createdAt: string;
}

export type EnvironmentStatus = "active" | "deleted";

export interface Environment {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  status: EnvironmentStatus;
  createdAt: string;
}

export interface SnapshotEntry {
  envId: string;
  name: string;
  level: ScopeType;
  sourcePath: string;
  declarationId: string;
  declarationVersion: number;
  value: string;
  fingerprint: string;
  createdAt: string;
}

export interface ResolvedSecret {
  name: string;
  level: ScopeType;
  sourcePath: string;
  declarationId: string;
  declarationVersion: number;
  value: string;
  fingerprint: string;
}

export interface MaskedSecret {
  name: string;
  level: ScopeType;
  fingerprint: string;
}

export interface BindingRow {
  envId: string;
  envName: string;
  envStatus: EnvironmentStatus;
  name: string;
  level: ScopeType;
  sourcePath: string;
  declarationId: string;
  declarationVersion: number;
  fingerprint: string;
}
