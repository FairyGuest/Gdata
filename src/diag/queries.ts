import { Ledger } from '../state/ledger.js';
import { LoanView } from '../contract/types.js';
import { conflictError, REASONS } from '../contract/errors.js';

export class DiagnosticService {
  constructor(private readonly ledger: Ledger) {}

  loanView(loanId: number): LoanView {
    const loan = this.ledger.loan(loanId);
    if (!loan) conflictError(REASONS.loan_not_found, 'loan does not exist', { loanId });
    const tick = this.ledger.getTick();
    return {
      loanId: loan.id,
      borrower: loan.borrower,
      tokenId: loan.token_id,
      principal: loan.principal,
      openedTick: loan.opened_tick,
      status: loan.status,
      settledTick: loan.settled_tick,
      settlement: loan.status === 'active' ? this.ledger.settlement(loan, tick) : null,
    };
  }

  systemState() {
    return {
      tick: this.ledger.getTick(),
      totalCash: this.ledger.totalCash(),
      nftCount: this.ledger.nftCount(),
      escrowedNfts: this.ledger.db
        .prepare("SELECT token_id, holder FROM nfts WHERE holder IN ('escrow', 'lender-pool') ORDER BY token_id")
        .all(),
      balances: this.ledger.db.prepare('SELECT account, amount FROM balances ORDER BY account').all(),
      loans: this.ledger.db.prepare('SELECT id, borrower, token_id, principal, opened_tick, status, settled_tick, settle_commit_seq FROM loans ORDER BY id').all(),
      commitLog: this.ledger.listCommitLog(),
    };
  }
}

