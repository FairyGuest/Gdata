/** Error taxonomy shared across all module boundaries. */
export type VaultErrorCode =
  | "VALIDATION_ERROR" // malformed input (contract parse failure) -> 400
  | "SECRET_NOT_FOUND" // secret name does not exist -> 404
  | "VERSION_NOT_FOUND" // version does not exist for the secret -> 404
  | "VERSION_EXPIRED" // version exists but its rotation grace period elapsed -> 410
  | "CONFLICT" // state conflict (e.g. rotate with no versions) -> 409
  | "STORAGE_ERROR" // state adapter failure (incl. resource exhaustion) -> 500
  | "CRYPTO_ERROR" // encrypt/decrypt computation failure -> 500
  | "AUDIT_ERROR" // audit write failed; business op rolled back -> 500
  | "INTERNAL_ERROR"; // unclassified -> 500

const HTTP_STATUS: Record<VaultErrorCode, number> = {
  VALIDATION_ERROR: 400,
  SECRET_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  VERSION_EXPIRED: 410,
  CONFLICT: 409,
  STORAGE_ERROR: 500,
  CRYPTO_ERROR: 500,
  AUDIT_ERROR: 500,
  INTERNAL_ERROR: 500,
};

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: VaultErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}

export function toVaultError(err: unknown, fallback: VaultErrorCode = "INTERNAL_ERROR"): VaultError {
  if (err instanceof VaultError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new VaultError(fallback, message);
}
