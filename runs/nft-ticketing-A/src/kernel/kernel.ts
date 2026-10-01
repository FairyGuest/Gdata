import { Errors } from "../contract/errors.ts";
import type {
  CheckInCommand,
  Command,
  CommandResult,
  PurchaseCommand,
  RefundCommand,
  TransferCommand,
} from "../contract/types.ts";
import type { Ledger, LedgerTx } from "../state/ledger.ts";

function failure(
  cmd: Command,
  commitSeq: number,
  reason: string,
  errorClass: string,
  tx: LedgerTx,
): CommandResult {
  tx.recordAttempt({
    runId: cmd.runId,
    reqSeq: cmd.seq,
    action: cmd.kind,
    ok: false,
    reason,
    commitSeq,
  });
  return {
    ok: false,
    runId: cmd.runId,
    seq: cmd.seq,
    action: cmd.kind,
    commitSeq,
    reason,
    errorClass,
  };
}

/**
 * Decision kernel. Each command runs inside one SQLite transaction.
 * Concurrency is adjudicated by transaction commit order (global commit_log
 * autoincrement), never by request arrival timestamps.
 */
export class Kernel {
  constructor(private readonly ledger: Ledger) {}

  execute(cmd: Command): CommandResult {
    return this.ledger.txn((tx) => {
      try {
        return this.dispatch(cmd, tx);
      } catch (err) {
        if (err instanceof Error && err.name === "DomainError") {
          throw err;
        }
        throw Errors.transactionFailed({
          action: cmd.kind,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private dispatch(cmd: Command, tx: LedgerTx): CommandResult {
    switch (cmd.kind) {
      case "purchase":
        return this.purchase(cmd, tx);
      case "transfer":
        return this.transfer(cmd, tx);
      case "refund":
        return this.refund(cmd, tx);
      case "checkin":
        return this.checkIn(cmd, tx);
    }
  }

  private purchase(cmd: PurchaseCommand, tx: LedgerTx): CommandResult {
    const { sessionId, seatCode, userId } = cmd;

    // 1) Explicit seat-uniqueness check inside the transaction.
    if (tx.liveSeatExists(sessionId, seatCode)) {
      const commitSeq = tx.appendCommit({
        runId: cmd.runId,
        reqSeq: cmd.seq,
        action: cmd.kind,
        ok: false,
        reason: "seat_taken",
      });
      return failure(cmd, commitSeq, "seat_taken", "conflict", tx);
    }

    // 2) Per-user purchase limit.
    const limit = this.ledger.sessionLimit(sessionId);
    const held = tx.heldCount(userId, sessionId);
    if (held >= limit) {
      const commitSeq = tx.appendCommit({
        runId: cmd.runId,
        reqSeq: cmd.seq,
        action: cmd.kind,
        ok: false,
        reason: "purchase_limit_reached",
      });
      return failure(cmd, commitSeq, "purchase_limit_reached", "conflict", tx);
    }

    // 3) Balance check + debit, atomically with issuance.
    const price = this.ledger.seatPrice(sessionId, seatCode);
    const balance = tx.balance(userId);
    if (balance < price) {
      const commitSeq = tx.appendCommit({
        runId: cmd.runId,
        reqSeq: cmd.seq,
        action: cmd.kind,
        ok: false,
        reason: "insufficient_funds",
      });
      return failure(cmd, commitSeq, "insufficient_funds", "conflict", tx);
    }

    tx.setBalance(userId, balance - price);
    const generation = tx.nextSeatGeneration(sessionId, seatCode);
    const ticketId = `${sessionId}:${seatCode}#g${generation}`;
    const issueSeq = tx.appendCommit({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
    });
    tx.insertTicket({ ticketId, sessionId, seatCode, holderUserId: userId, issueSeq });
    tx.logOwnership({ ticketId, action: "issue", fromUserId: null, toUserId: userId });
    tx.recordAttempt({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
      commitSeq: issueSeq,
    });
    return {
      ok: true,
      runId: cmd.runId,
      seq: cmd.seq,
      action: "purchase",
      commitSeq: issueSeq,
      ticketId,
    };
  }

  private transfer(cmd: TransferCommand, tx: LedgerTx): CommandResult {
    const ticket = tx.getTicketForUpdate(cmd.ticketId);
    if (!ticket) {
      throw Errors.unknownTicket(cmd.ticketId);
    }
    if (ticket.status === "voided") {
      return this.conflictCommit(cmd, tx, "voided");
    }
    if (ticket.status === "checked_in") {
      return this.conflictCommit(cmd, tx, "already_checked_in");
    }
    if (ticket.holderUserId !== cmd.fromUserId) {
      return this.conflictCommit(cmd, tx, "not_holder");
    }

    tx.setHolder(cmd.ticketId, cmd.toUserId);
    const commitSeq = tx.appendCommit({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
    });
    tx.logOwnership({
      ticketId: cmd.ticketId,
      action: "transfer",
      fromUserId: cmd.fromUserId,
      toUserId: cmd.toUserId,
    });
    tx.recordAttempt({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
      commitSeq,
    });
    return {
      ok: true,
      runId: cmd.runId,
      seq: cmd.seq,
      action: "transfer",
      commitSeq,
      ticketId: cmd.ticketId,
    };
  }

  private refund(cmd: RefundCommand, tx: LedgerTx): CommandResult {
    const ticket = tx.getTicketForUpdate(cmd.ticketId);
    if (!ticket) {
      throw Errors.unknownTicket(cmd.ticketId);
    }
    if (ticket.status === "voided") {
      return this.conflictCommit(cmd, tx, "voided");
    }
    if (ticket.status === "checked_in") {
      return this.conflictCommit(cmd, tx, "already_checked_in");
    }
    if (ticket.holderUserId !== cmd.userId) {
      return this.conflictCommit(cmd, tx, "not_holder");
    }

    // Release seat + limit and refund the seat price, atomically.
    const price = this.ledger.seatPrice(ticket.sessionId, ticket.seatCode);
    const balance = tx.balance(cmd.userId);
    tx.setBalance(cmd.userId, balance + price);
    const commitSeq = tx.appendCommit({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
    });
    tx.markVoided(cmd.ticketId, commitSeq);
    tx.logOwnership({
      ticketId: cmd.ticketId,
      action: "refund",
      fromUserId: cmd.userId,
      toUserId: null,
    });
    tx.recordAttempt({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
      commitSeq,
    });
    return {
      ok: true,
      runId: cmd.runId,
      seq: cmd.seq,
      action: "refund",
      commitSeq,
      ticketId: cmd.ticketId,
    };
  }

  private checkIn(cmd: CheckInCommand, tx: LedgerTx): CommandResult {
    const ticket = tx.getTicketForUpdate(cmd.ticketId);
    if (!ticket) {
      throw Errors.unknownTicket(cmd.ticketId);
    }
    if (ticket.status === "voided") {
      return this.conflictCommit(cmd, tx, "voided");
    }
    if (ticket.status === "checked_in") {
      return this.conflictCommit(cmd, tx, "already_checked_in");
    }
    if (ticket.holderUserId !== cmd.userId) {
      return this.conflictCommit(cmd, tx, "not_holder");
    }

    const commitSeq = tx.appendCommit({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
    });
    tx.markCheckedIn(cmd.ticketId, commitSeq);
    tx.logOwnership({
      ticketId: cmd.ticketId,
      action: "checkin",
      fromUserId: cmd.userId,
      toUserId: cmd.userId,
    });
    tx.recordAttempt({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: true,
      reason: null,
      commitSeq,
    });
    return {
      ok: true,
      runId: cmd.runId,
      seq: cmd.seq,
      action: "checkin",
      commitSeq,
      ticketId: cmd.ticketId,
    };
  }

  /** Conflicts also append a commit record so the global ordering stays total. */
  private conflictCommit(cmd: Command, tx: LedgerTx, reason: string): CommandResult {
    const commitSeq = tx.appendCommit({
      runId: cmd.runId,
      reqSeq: cmd.seq,
      action: cmd.kind,
      ok: false,
      reason,
    });
    return failure(cmd, commitSeq, reason, "conflict", tx);
  }
}


