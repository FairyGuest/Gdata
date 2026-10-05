import type { CaseResult, RawCaseOutcome } from "../contract/types.ts";

/**
 * Status adapter: translate raw kernel outcomes into the public
 * passed/failed/timeout contract. This is the single place where the
 * mapping is defined, so the kernel never leaks its internal vocabulary.
 */
export function toCaseResult(file: string, caseName: string, outcome: RawCaseOutcome): CaseResult {
  const base = {
    caseId: file + "#" + caseName,
    file,
    caseName,
    durationMs: outcome.durationMs,
  };
  switch (outcome.kind) {
    case "ok":
      return { ...base, status: "passed" };
    case "error":
      return { ...base, status: "failed", error: outcome.error };
    case "timeout":
      return {
        ...base,
        status: "timeout",
        error: {
          name: "TimeoutError",
          message: "case exceeded timeout of " + outcome.timeoutMs + "ms (terminated after " + outcome.durationMs + "ms)",
        },
      };
    case "worker-crash":
      return {
        ...base,
        status: "failed",
        error: { name: outcome.error.name, message: "worker crashed: " + outcome.error.message, stack: outcome.error.stack },
      };
  }
}

export function adaptAll(
  files: { relPath: string; cases: string[] }[],
  outcomes: Map<string, RawCaseOutcome>,
): CaseResult[] {
  const results: CaseResult[] = [];
  for (const f of files) {
    for (const c of f.cases) {
      const outcome = outcomes.get(f.relPath + "#" + c);
      if (!outcome) {
        // Defensive: should never happen; surface as failure, never success.
        results.push({
          caseId: f.relPath + "#" + c,
          file: f.relPath,
          caseName: c,
          status: "failed",
          durationMs: 0,
          error: { name: "InternalError", message: "case was not executed" },
        });
        continue;
      }
      results.push(toCaseResult(f.relPath, c, outcome));
    }
  }
  return results;
}
