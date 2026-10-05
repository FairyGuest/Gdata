// 错误契约：所有模块抛出的错误必须是 AppError，错误码可区分。

export type ErrorCode =
  | "INPUT_ERROR"
  | "UNKNOWN_STATUS"
  | "STATUS_CONFLICT"
  | "RESOURCE_EXHAUSTED"
  | "NOT_FOUND"
  | "COMPUTATION_FAILED"
  | "STORAGE_FAILED";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const inputError = (msg: string, details?: unknown) =>
  new AppError("INPUT_ERROR", msg, 400, details);
export const unknownStatus = (msg: string, details?: unknown) =>
  new AppError("UNKNOWN_STATUS", msg, 422, details);
export const statusConflict = (msg: string, details?: unknown) =>
  new AppError("STATUS_CONFLICT", msg, 409, details);
export const resourceExhausted = (msg: string, details?: unknown) =>
  new AppError("RESOURCE_EXHAUSTED", msg, 413, details);
export const notFound = (msg: string, details?: unknown) =>
  new AppError("NOT_FOUND", msg, 404, details);
export const computationFailed = (msg: string, details?: unknown) =>
  new AppError("COMPUTATION_FAILED", msg, 500, details);
export const storageFailed = (msg: string, details?: unknown) =>
  new AppError("STORAGE_FAILED", msg, 500, details);
