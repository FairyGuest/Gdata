// Shared data and error contracts between modules.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const LAYER_NAMES = ['base', 'env', 'instance'] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export type Layers = Record<LayerName, JsonObject>;

export type DriftCategory = 'missing' | 'mismatch' | 'extra';

export interface DriftItem {
  path: string;
  category: DriftCategory;
  expected?: JsonValue;
  actual?: JsonValue;
  reason: string;
}

export interface DriftReport {
  status: 'pass' | 'drifted';
  counts: Record<DriftCategory, number>;
  items: DriftItem[];
}

export interface MergeStepLog {
  layer: LayerName;
  appliedKeys: number;
  deletedKeys: number;
  note: string;
}

export interface EvaluationResult {
  effective: JsonObject;
  drift: DriftReport;
  mergeLog: MergeStepLog[];
}

// Error codes are part of the cross-module error contract.
export const ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_LAYER',
  'NOT_FOUND',
  'STATE_CONFLICT',
  'RESOURCE_EXHAUSTED',
  'COMPUTATION_FAILURE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details?: JsonObject;
  constructor(code: ErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: JsonObject };
}

export interface RunRecord {
  runId: string;
  env: string;
  createdAt: string;
  input: { layers: Layers; snapshot: JsonObject };
  output: EvaluationResult;
}
