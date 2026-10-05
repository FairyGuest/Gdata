// 契约解析：把不可信输入校验为 TestRunInput[]，非法输入抛 INPUT_ERROR。

import type { TestCaseInput, TestRunInput } from "./types.ts";
import { inputError } from "../diagnostics/errors.ts";

function parseCase(raw: unknown, where: string): TestCaseInput {
  if (typeof raw !== "object" || raw === null) {
    throw inputError(`${where}: case must be an object`, { raw });
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.file !== "string" || c.file.length === 0) {
    throw inputError(`${where}: file must be a non-empty string`, { raw });
  }
  if (typeof c.name !== "string" || c.name.length === 0) {
    throw inputError(`${where}: name must be a non-empty string`, { raw });
  }
  if (typeof c.status !== "string") {
    throw inputError(`${where}: status must be a string`, { raw });
  }
  if (typeof c.durationMs !== "number" || !Number.isFinite(c.durationMs) || c.durationMs < 0) {
    throw inputError(`${where}: durationMs must be a non-negative finite number`, { raw });
  }
  return { file: c.file, name: c.name, status: c.status, durationMs: c.durationMs };
}

export function parseRunsPayload(body: unknown): TestRunInput[] {
  if (typeof body !== "object" || body === null || !Array.isArray((body as any).runs)) {
    throw inputError("body must be an object with a 'runs' array");
  }
  const runs = (body as any).runs as unknown[];
  if (runs.length === 0) {
    throw inputError("runs must not be empty");
  }
  return runs.map((r, i) => {
    const where = `runs[${i}]`;
    if (typeof r !== "object" || r === null) {
      throw inputError(`${where}: run must be an object`);
    }
    const run = r as Record<string, unknown>;
    if (typeof run.runId !== "string" || run.runId.length === 0) {
      throw inputError(`${where}: runId must be a non-empty string`);
    }
    if (!Array.isArray(run.cases)) {
      throw inputError(`${where}: cases must be an array`);
    }
    return {
      runId: run.runId,
      cases: run.cases.map((c, j) => parseCase(c, `${where}.cases[${j}]`)),
    };
  });
}
