import type { ErrorCategory } from "./errors.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DiffKind = "added" | "removed" | "changed";

export interface DiffEntry {
  path: string;
  kind: DiffKind;
  before?: JsonValue;
  after?: JsonValue;
}

export interface CompareRequest {
  key: string;
  data: JsonValue;
  ignorePaths?: string[];
  createIfMissing?: boolean;
  updateOnMismatch?: boolean;
}

export interface UpdateRequest {
  key: string;
  data: JsonValue;
}

export type CompareStatus = "created" | "passed" | "failed" | "updated";

export interface CompareResult {
  runId: string;
  key: string;
  status: CompareStatus;
  reason: string;
  diff: DiffEntry[];
  diffTruncated: boolean;
  ignoredPaths: string[];
}

export interface RunRecord {
  runId: string;
  key: string;
  action: string;
  status: string;
  reason: string;
  detail: unknown;
  createdAt: string;
}

export interface ErrorBody {
  ok: false;
  runId: string | null;
  error: { category: ErrorCategory; message: string; detail?: unknown };
}

export interface SuccessBody<T> {
  ok: true;
  runId: string | null;
  data: T;
}

export type ApiBody<T> = SuccessBody<T> | ErrorBody;
