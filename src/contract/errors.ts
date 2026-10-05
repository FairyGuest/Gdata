/** Typed errors so callers can distinguish failure categories. */

export type ErrorCode =
  | "INPUT_ERROR" // invalid user input (bad dir, bad pattern, malformed test file)
  | "STATE_CONFLICT" // conflicting state (e.g. a run is already active for the dir)
  | "RESOURCE_EXHAUSTED" // too many concurrent runs / parallelism above limit
  | "EXECUTION_ERROR" // unexpected failure inside the runner itself
  | "NOT_FOUND"; // requested resource does not exist

export class RunnerError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const inputError = (msg: string) => new RunnerError("INPUT_ERROR", 400, msg);
export const stateConflict = (msg: string) => new RunnerError("STATE_CONFLICT", 409, msg);
export const resourceExhausted = (msg: string) => new RunnerError("RESOURCE_EXHAUSTED", 503, msg);
export const executionError = (msg: string) => new RunnerError("EXECUTION_ERROR", 500, msg);
export const notFound = (msg: string) => new RunnerError("NOT_FOUND", 404, msg);
