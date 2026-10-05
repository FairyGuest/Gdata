// 状态适配层：把外部测试框架的状态词归一化为规范状态。

import type { CanonicalStatus } from "../contracts/types.ts";
import { unknownStatus } from "../diagnostics/errors.ts";

const STATUS_MAP: Record<string, CanonicalStatus> = {
  pass: "passed",
  passed: "passed",
  ok: "passed",
  success: "passed",
  fail: "failed",
  failed: "failed",
  failure: "failed",
  error: "failed",
  broken: "failed",
  skip: "skipped",
  skipped: "skipped",
  pending: "skipped",
  ignored: "skipped",
  todo: "skipped",
  disabled: "skipped",
};

export function normalizeStatus(raw: string, context?: string): CanonicalStatus {
  if (typeof raw !== "string") {
    throw unknownStatus("status must be a string", { raw, context });
  }
  const hit = STATUS_MAP[raw.trim().toLowerCase()];
  if (!hit) {
    throw unknownStatus(`unrecognized test status: ${JSON.stringify(raw)}`, { raw, context });
  }
  return hit;
}
