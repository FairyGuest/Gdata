// Error taxonomy shared across all modules.
// Every failure surfaced by the service is one of these categories;
// unknown exceptions are mapped to COMPUTATION_FAILURE, never to success.

export type ErrorCategory =
  | 'INPUT_ERROR'          // contract/validation failure (HTTP 400)
  | 'STATE_CONFLICT'       // idempotency-key reuse with different payload (HTTP 409)
  | 'NOT_FOUND'            // referenced run does not exist (HTTP 404)
  | 'RESOURCE_EXHAUSTED'   // graph limits exceeded (HTTP 413)
  | 'COMPUTATION_FAILURE'; // unexpected internal failure (HTTP 500)

const STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 413,
  COMPUTATION_FAILURE: 500,
};

export class ScanError extends Error {
  readonly category: ErrorCategory;
  readonly statusCode: number;
  readonly detail?: unknown;
  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.category = category;
    this.statusCode = STATUS[category];
    this.detail = detail;
  }
}

export function toScanError(err: unknown): ScanError {
  if (err instanceof ScanError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ScanError('COMPUTATION_FAILURE', msg);
}
