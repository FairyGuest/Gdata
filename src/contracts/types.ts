// Shared data contracts between modules. Erasable-syntax-only TypeScript.

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export const LAYER_NAMES = ["base", "env", "instance"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface LayerSet {
  base: JsonValue;
  env: JsonValue;
  instance: JsonValue;
}

export interface MergeInput {
  env: string;
  layers: LayerSet;
}

export interface MergeOutput {
  env: string;
  effective: JsonObject;
}

export const DRIFT_KINDS = ["missing_required", "value_mismatch", "extra_in_snapshot"] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

// Severity: missing_required (heaviest) > value_mismatch > extra_in_snapshot (lightest).
export const DRIFT_SEVERITY: Record<DriftKind, number> = {
  missing_required: 3,
  value_mismatch: 2,
  extra_in_snapshot: 1,
};

export interface DriftEntry {
  path: string; // dot-separated, e.g. "services.api.timeoutMs"
  kind: DriftKind;
  expected?: JsonValue; // present for missing_required / value_mismatch
  actual?: JsonValue;   // present for value_mismatch / extra_in_snapshot
  reason: string;
}

export interface DriftReport {
  status: "PASS" | "DRIFT";
  env: string;
  drifts: DriftEntry[]; // ordered by severity desc, then path asc
  counts: Record<DriftKind, number>;
}

export interface DriftInput {
  env: string;
  layers: LayerSet;
  snapshot: JsonValue;
}

export interface DriftOutput {
  runId: string;
  merge: MergeOutput;
  report: DriftReport;
}

export interface RunRecord {
  runId: string;
  env: string;
  createdAt: string;
  input: DriftInput;
  merge: MergeOutput;
  report: DriftReport;
}
