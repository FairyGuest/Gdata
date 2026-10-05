// Contract layer: shared data & error contracts between modules.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type DiffType = "added" | "removed" | "modified";

export interface FieldDiff {
  path: string;          // dotted path, array index as [i], e.g. "user.address.city", "items[2].id"
  type: DiffType;
  before?: JsonValue;    // value in stored snapshot (absent for "added")
  after?: JsonValue;     // value in incoming payload (absent for "removed")
}

export type CompareStatus = "created" | "passed" | "failed" | "updated";

export interface CompareRequest {
  name: string;
  data: JsonValue;
  ignorePaths?: string[];
  update?: boolean;      // force overwrite stored snapshot with incoming data
}

export interface CompareResponse {
  runId: string;
  name: string;
  status: CompareStatus;
  diffs: FieldDiff[];
  ignoredPaths: string[];
  reason: string;        // human-readable decision rationale (also logged)
}

export interface SnapshotRecord {
  name: string;
  data: JsonValue;
  createdAt: string;
  updatedAt: string;
}

// Error taxonomy. category is machine-readable and stable across modules.
export type ErrorCategory = "INPUT_ERROR" | "STATE_CONFLICT" | "RESOURCE_EXHAUSTED" | "COMPUTE_FAILURE";

export const ERROR_HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 507,
  COMPUTE_FAILURE: 500,
};

export interface ErrorBody {
  runId: string;
  error: {
    category: ErrorCategory;
    code: string;       // fine-grained code, e.g. INVALID_JSON, SNAPSHOT_LIMIT
    message: string;
  };
}
