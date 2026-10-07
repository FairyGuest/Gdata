// Domain & error contracts shared across all modules.
// Every cross-module structure and failure mode is declared here so the
// contract parser (HTTP), execution kernel (core) and state adapter (state)
// agree on shapes and error categories.

export type ScopeLevel = 'org' | 'project' | 'env';

export const SCOPE_RANK: Record<ScopeLevel, number> = { org: 1, project: 2, env: 3 };

export interface ScopeRef {
  level: ScopeLevel;
  org: string;
  project?: string;
  env?: string;
}

export interface Declaration {
  id: string;
  scopeLevel: ScopeLevel;
  org: string;
  project: string | null;
  env: string | null;
  name: string;
  value: string;
  version: number;
  updatedAt: string;
}

export interface ResolvedSecret {
  name: string;
  value: string;
  sourceLevel: ScopeLevel;
  sourcePath: string;
  declarationId: string;
  declarationVersion: number;
}

export interface EnvironmentRow {
  id: string;
  org: string;
  project: string;
  env: string;
  status: 'active' | 'deleted';
  createdAt: string;
  deletedAt: string | null;
}

export interface SnapshotEntry {
  id: string;
  environmentId: string;
  name: string;
  value: string;
  fingerprint: string;
  sourceLevel: ScopeLevel;
  sourcePath: string;
  declarationId: string;
  declarationVersion: number;
  createdAt: string;
}

/** Redacted view of a snapshot entry: never carries the plaintext value. */
export interface RedactedSecret {
  name: string;
  level: ScopeLevel;
  sourcePath: string;
  fingerprint: string;
  declarationVersion: number;
  snapshotId: string;
  capturedAt: string;
}

export type ErrorCategory =
  | 'INPUT_ERROR'        // malformed request / contract violation by caller
  | 'NOT_FOUND'          // referenced resource does not exist
  | 'STATE_CONFLICT'     // current state forbids the operation (e.g. referenced declaration)
  | 'RESOURCE_EXHAUSTED' // limits exceeded (payload size, snapshot size)
  | 'INTERNAL_FAILURE';  // unexpected kernel/adapter failure

export const ERROR_HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 413,
  INTERNAL_FAILURE: 500,
};

export interface ServiceErrorDetails {
  [key: string]: unknown;
}

export class ServiceError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details: ServiceErrorDetails;

  constructor(category: ErrorCategory, code: string, message: string, details: ServiceErrorDetails = {}) {
    super(message);
    this.name = 'ServiceError';
    this.category = category;
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.category];
  }

  toJSON() {
    return {
      error: {
        category: this.category,
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}
