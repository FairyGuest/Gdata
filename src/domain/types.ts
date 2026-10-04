/** 模块间共享的数据契约。 */
export type ScopeLevel = 'global' | 'org' | 'project';

export interface Scope {
  id: string;
  level: ScopeLevel;
  parentId: string | null;
  quotaLimit: number;
  quotaUsed: number;
}

export type KeyStatus = 'active' | 'grace' | 'expired';

export interface ApiKey {
  id: string;
  secret: string;
  projectScopeId: string;
  status: KeyStatus;
  createdAt: number;
  graceUntil: number | null;
  rotatedTo: string | null;
}

export interface UsageEvent {
  id: number;
  keyId: string;
  amount: number;
  at: number;
  requestId: string | null;
}

export interface LevelBalance {
  level: ScopeLevel;
  scopeId: string;
  limit: number;
  used: number;
  remaining: number;
}

export interface ConsumeResult {
  keyId: string;
  amount: number;
  at: number;
  requestId: string | null;
  balances: LevelBalance[];
}

export interface RotateResult {
  oldKey: ApiKey;
  newKey: ApiKey;
}

export interface UsageReport {
  keyId: string;
  status: KeyStatus;
  totalConsumed: number;
  events: UsageEvent[];
  balances: LevelBalance[];
}

