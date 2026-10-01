export type ErrorKind = "input" | "conflict" | "resource" | "compute";

/** HTTP status per error category: 422 input, 409 conflict, 503 resource, 500 compute. */
export const STATUS_BY_KIND: Record<ErrorKind, number> = {
  input: 422,
  conflict: 409,
  resource: 503,
  compute: 500,
};

export class KernelError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "KernelError";
  }
}

export const conflict = (reason: string, msg?: string) => new KernelError("conflict", reason, msg);
export const resource = (reason: string, msg?: string) => new KernelError("resource", reason, msg);
export const compute = (reason: string, msg?: string) => new KernelError("compute", reason, msg);
