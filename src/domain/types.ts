// Shared domain types for the devcontainer registry service.

export type InstanceStatus =
  | 'PENDING'
  | 'PROVISIONING'
  | 'READY'
  | 'SUSPENDED'
  | 'DELETED';

export interface ResourceQuota {
  cpu: number;
  memoryMb: number;
}

export interface TemplateSpec {
  name: string;
  image: string;
  features: string[];
  resources: ResourceQuota;
  idleTimeoutMs: number;
}

export interface ProvisionRequest {
  name: string;
  template: string;
  overrides?: Partial<ResourceQuota>;
}

export interface InstanceRecord {
  id: string;
  name: string;
  template: string;
  status: InstanceStatus;
  resources: ResourceQuota;
  createdAt: number;
  updatedAt: number;
}

export interface TransitionRecord {
  id: number;
  instanceId: string;
  runId: string;
  fromStatus: InstanceStatus | null;
  toStatus: InstanceStatus;
  reason: string;
  at: number;
}

export interface InstanceQuery {
  template?: string;
  status?: InstanceStatus;
}
