// Error contract shared by all modules. Every failure raised by the system
// is one of these categories so callers (HTTP layer, tests, CLI) can
// distinguish input errors, state conflicts, resource exhaustion and
// computation failures instead of collapsing everything into "success".

export type ErrorCategory = "contract" | "state-conflict" | "resource-exhausted" | "computation" | "not-found";

export class OrchestratorError extends Error {
  readonly category: ErrorCategory;
  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.category = category;
  }
}

/** Invalid user input: malformed target definitions, bad event payloads, cycles. */
export class ContractError extends OrchestratorError {
  constructor(message: string) { super("contract", message); }
}

/** The request conflicts with current runtime state (e.g. redefining targets mid-build). */
export class StateConflictError extends OrchestratorError {
  constructor(message: string) { super("state-conflict", message); }
}

/** A configured capacity limit was exceeded (queue depth, target count, ...). */
export class ResourceExhaustedError extends OrchestratorError {
  constructor(message: string) { super("resource-exhausted", message); }
}

/** An internal computation failed (graph error, builder crash, store failure). */
export class ComputationError extends OrchestratorError {
  constructor(message: string) { super("computation", message); }
}

/** The requested entity does not exist. */
export class NotFoundError extends OrchestratorError {
  constructor(message: string) { super("not-found", message); }
}
