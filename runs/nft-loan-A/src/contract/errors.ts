export type ErrorCategory = 'input' | 'conflict' | 'resource' | 'computation';

export const HTTP_STATUS: Record<ErrorCategory, number> = {
  input: 422,
  conflict: 409,
  resource: 503,
  computation: 500,
};

export const REASONS = {
  invalid_field: 'invalid_field',
  amount_out_of_range: 'amount_out_of_range',
  bps_out_of_range: 'bps_out_of_range',
  insufficient_collateral: 'insufficient_collateral',
  insufficient_liquidity: 'insufficient_liquidity',
  loan_not_found: 'loan_not_found',
  loan_already_settled: 'loan_already_settled',
  repayment_too_small: 'repayment_too_small',
  liquidation_line_not_crossed: 'liquidation_line_not_crossed',
  nft_not_held: 'nft_not_held',
  nft_already_escrowed: 'nft_already_escrowed',
  resource_busy: 'resource_busy',
  computation_failed: 'computation_failed',
} as const;

export class DomainError extends Error {
  readonly category: ErrorCategory;
  readonly reason: string;
  readonly detail: Record<string, unknown>;

  constructor(category: ErrorCategory, reason: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.category = category;
    this.reason = reason;
    this.detail = detail;
  }

  toBody(runId: string) {
    return { ok: false, runId, error: { category: this.category, reason: this.reason, message: this.message, detail: this.detail } };
  }
}

export function inputError(reason: string, message: string, detail?: Record<string, unknown>): never {
  throw new DomainError('input', reason, message, detail);
}

export function conflictError(reason: string, message: string, detail?: Record<string, unknown>): never {
  throw new DomainError('conflict', reason, message, detail);
}

export function resourceError(reason: string, message: string, detail?: Record<string, unknown>): never {
  throw new DomainError('resource', reason, message, detail);
}

export function computationError(reason: string, message: string, detail?: Record<string, unknown>): never {
  throw new DomainError('computation', reason, message, detail);
}
