export type ErrorReason =
  | 'invalid_input'
  | 'event_not_found'
  | 'seat_not_found'
  | 'user_not_found'
  | 'ticket_not_found'
  | 'seat_held'
  | 'purchase_limit_reached'
  | 'insufficient_balance'
  | 'not_holder'
  | 'already_checked_in'
  | 'voided'
  | 'database_busy'
  | 'storage_exhausted'
  | 'compute_failed';

export class DomainError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422 | 500 | 503,
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function invalidInput(message: string): never {
  throw new DomainError(422, 'invalid_input', message);
}
