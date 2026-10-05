// Error contract: every failure crossing a module boundary is a ServiceError
// with a stable, machine-distinguishable code. Unknown states are never
// silently mapped to success.

export type ErrorCode =
  | 'INPUT_INVALID'       // malformed request / unparsable contract
  | 'NOT_FOUND'           // unknown run id / missing file
  | 'STATE_CONFLICT'      // e.g. concurrent run on the same project dir
  | 'RESOURCE_EXHAUSTED'  // mutant count budget exceeded
  | 'EXECUTION_FAILED'    // test runner crashed, spawn failure, etc.
  | 'INTERNAL';           // anything unclassified; surfaces as 500

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'INPUT_INVALID': return 400;
    case 'NOT_FOUND': return 404;
    case 'STATE_CONFLICT': return 409;
    case 'RESOURCE_EXHAUSTED': return 429;
    case 'EXECUTION_FAILED': return 502;
    case 'INTERNAL': return 500;
  }
}

export function toErrorBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof ServiceError) {
    return {
      status: httpStatusFor(err.code),
      body: { error: { code: err.code, message: err.message, details: err.details ?? null } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL', message, details: null } } };
}

