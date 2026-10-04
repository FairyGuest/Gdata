/** Error categories shared across all module boundaries. */
export type ErrorCategory = "input" | "conflict" | "resource" | "internal";

export class RbacError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  constructor(category: ErrorCategory, code: string, message: string) {
    super(message);
    this.name = "RbacError";
    this.category = category;
    this.code = code;
  }
}

export const inputError = (code: string, message: string) =>
  new RbacError("input", code, message);
export const conflictError = (code: string, message: string) =>
  new RbacError("conflict", code, message);
export const resourceError = (code: string, message: string) =>
  new RbacError("resource", code, message);
export const internalError = (code: string, message: string) =>
  new RbacError("internal", code, message);

/** HTTP status mapping for the API boundary. */
export const categoryToStatus = (c: ErrorCategory): number =>
  c === "input" ? 400 : c === "conflict" ? 409 : c === "resource" ? 507 : 500;
