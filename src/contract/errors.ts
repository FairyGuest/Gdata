/**
 * Domain error taxonomy. Single place that maps a domain failure category to
 * its HTTP status: 422 input | 409 conflict | 503 exhausted | 500 compute.
 */
export type ErrorClass = "input" | "conflict" | "exhausted" | "compute";

export interface ErrorShape {
  errorClass: ErrorClass;
  reason: string;
  message: string;
  detail?: Record<string, unknown>;
}

export const HTTP_STATUS: Record<ErrorClass, number> = {
  input: 422,
  conflict: 409,
  exhausted: 503,
  compute: 500,
};

export class DomainError extends Error {
  readonly errorClass: ErrorClass;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;

  constructor(shape: ErrorShape) {
    super(shape.message);
    this.name = "DomainError";
    this.errorClass = shape.errorClass;
    this.reason = shape.reason;
    this.detail = shape.detail;
  }

  httpStatus(): number {
    return HTTP_STATUS[this.errorClass];
  }

  toBody(): { error: ErrorShape } {
    return {
      error: {
        errorClass: this.errorClass,
        reason: this.reason,
        message: this.message,
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}

const inputError = (reason: string, message: string, detail?: Record<string, unknown>) =>
  new DomainError({ errorClass: "input", reason, message, detail });

const conflictError = (reason: string, message: string, detail?: Record<string, unknown>) =>
  new DomainError({ errorClass: "conflict", reason, message, detail });

const exhaustedError = (reason: string, message: string, detail?: Record<string, unknown>) =>
  new DomainError({ errorClass: "exhausted", reason, message, detail });

const computeError = (reason: string, message: string, detail?: Record<string, unknown>) =>
  new DomainError({ errorClass: "compute", reason, message, detail });

export const Errors = {
  missingField: (field: string) =>
    inputError("missing_field", `Field ${field} is required.`, { field }),
  invalidType: (field: string, expected: string) =>
    inputError("invalid_type", `Field ${field} must be ${expected}.`, { field, expected }),
  unknownSession: (sessionId: string) =>
    inputError("unknown_session", `Session ${sessionId} does not exist.`, { sessionId }),
  unknownSeat: (sessionId: string, seatCode: string) =>
    inputError(
      "unknown_seat",
      `Seat ${seatCode} is not part of session ${sessionId}.`,
      { sessionId, seatCode },
    ),
  unknownUser: (userId: string) =>
    inputError("unknown_user", `User ${userId} does not exist.`, { userId }),
  unknownTicket: (ticketId: string) =>
    inputError("unknown_ticket", `Ticket ${ticketId} does not exist.`, { ticketId }),
  sameUserTransfer: () =>
    inputError("same_user_transfer", "A ticket cannot be transferred to its current holder.", {}),

  seatTaken: (sessionId: string, seatCode: string) =>
    conflictError(
      "seat_taken",
      `Seat ${seatCode} in session ${sessionId} is already held.`,
      { sessionId, seatCode },
    ),
  purchaseLimitReached: (userId: string, sessionId: string, limit: number) =>
    conflictError(
      "purchase_limit_reached",
      `User ${userId} already holds the limit of ${limit} ticket(s) for session ${sessionId}.`,
      { userId, sessionId, limit },
    ),
  insufficientFunds: (userId: string, required: number, available: number) =>
    conflictError(
      "insufficient_funds",
      `User ${userId} has ${available}, needs ${required}.`,
      { userId, required, available },
    ),
  notHolder: (ticketId: string, userId: string) =>
    conflictError(
      "not_holder",
      `User ${userId} is not the current holder of ticket ${ticketId}.`,
      { ticketId, userId },
    ),
  alreadyCheckedIn: (ticketId: string) =>
    conflictError(
      "already_checked_in",
      `Ticket ${ticketId} has already been checked in.`,
      { ticketId },
    ),
  voided: (ticketId: string) =>
    conflictError("voided", `Ticket ${ticketId} has been refunded and is void.`, { ticketId }),

  ledgerBusy: () =>
    exhaustedError("ledger_busy", "The ledger could not acquire a write slot after retries."),
  balancePoolExhausted: (userId: string) =>
    exhaustedError("balance_pool_exhausted", `No balance available for user ${userId}.`, { userId }),

  invariantViolated: (reason: string, detail?: Record<string, unknown>) =>
    computeError("invariant_violated", `Ledger invariant violated: ${reason}`, detail),
  transactionFailed: (detail?: Record<string, unknown>) =>
    computeError("transaction_failed", "An internal transaction failed to commit.", detail),
};
