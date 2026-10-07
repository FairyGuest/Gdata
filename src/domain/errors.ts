// Error contract shared by all layers.
// Each error carries a stable code so HTTP / tests can distinguish
// input errors, state conflicts, resource exhaustion and internal failures.

export type ErrorCode =
  | 'TEMPLATE_VALIDATION'   // template spec failed validation (400)
  | 'OVERRIDE_INVALID'      // provision override invalid / unknown field (400)
  | 'INSTANCE_NOT_FOUND'    // instance (or template) not found (404)
  | 'NAME_CONFLICT'         // active instance with same name exists (409)
  | 'INVALID_TRANSITION'    // operation not allowed in current state (409)
  | 'TERMINAL_STATE'        // instance is DELETED, any op fails (410)
  | 'RESOURCE_EXHAUSTED'    // queue is full (429)
  | 'INTERNAL';             // unexpected failure (500)

export class DomainError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const isDomainError = (e: unknown): e is DomainError =>
  e instanceof DomainError;
