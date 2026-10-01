import { Ledger } from '../state/ledger.js';
import { BorrowCommand, LiquidateCommand, RepayCommand } from '../contract/types.js';
import { conflictError, REASONS } from '../contract/errors.js';
import { isBelowLiquidationLine, isCollateralSufficient } from './money.js';
import { LENDER_POOL } from '../state/fixtures.js';

export interface WriteOutcome {
  status: 'ok' | 'conflict';
  httpStatus: number;
  reason?: string;
  runId: string;
  tick: number;
  commitSeq: number;
  action: string;
  loanId: number | null;
  data: Record<string, unknown>;
}

export class LoanKernel {
  constructor(private readonly ledger: Ledger) {}

  borrow(cmd: BorrowCommand): WriteOutcome {
    return this.ledger.runWrite(() => {
      const cfg = this.ledger.cfg;
      const currentTick = this.ledger.getTick();
      const valuation = this.ledger.valuationAt(cmd.tokenId, currentTick);

      const holder = this.ledger.nftHolder(cmd.tokenId);
      if (holder !== cmd.borrower) {
        conflictError(REASONS.nft_not_held, 'borrower does not hold the collateral token', {
          tokenId: cmd.tokenId,
          expectedHolder: cmd.borrower,
          actualHolder: holder,
        });
      }

      if (!isCollateralSufficient(cmd.amount, valuation, cfg.loanToValueBps)) {
        conflictError(REASONS.insufficient_collateral, 'borrow amount exceeds collateral valuation x ltv bps', {
          amount: cmd.amount,
          valuation,
          ltvBps: cfg.loanToValueBps,
          maxAmount: Number((BigInt(valuation) * BigInt(cfg.loanToValueBps)) / 10000n),
          tick: currentTick,
        });
      }

      if (this.ledger.balance(LENDER_POOL) < cmd.amount) {
        conflictError(REASONS.insufficient_liquidity, 'lender pool cannot fund this loan', {
          requested: cmd.amount,
          available: this.ledger.balance(LENDER_POOL),
        });
      }

      const openedTick = this.ledger.bumpTick();
      const loanId = this.ledger.insertLoan(cmd.borrower, cmd.tokenId, cmd.amount, openedTick);

      this.ledger.addBalance(LENDER_POOL, -cmd.amount);
      this.ledger.addBalance(cmd.borrower, cmd.amount);
      this.ledger.transferNft(cmd.tokenId, 'escrow');

      const detail = {
        loanId,
        borrower: cmd.borrower,
        tokenId: cmd.tokenId,
        principal: cmd.amount,
        openedTick,
        valuationAtOpen: this.ledger.valuationAt(cmd.tokenId, openedTick),
        poolBalance: this.ledger.balance(LENDER_POOL),
      };
      const commitSeq = this.ledger.appendCommitLog({
        runId: cmd.runId,
        tick: openedTick,
        action: 'borrow',
        loanId,
        result: 'ok',
        reason: null,
        detail,
      });

      return {
        status: 'ok',
        httpStatus: 200,
        runId: cmd.runId,
        tick: openedTick,
        commitSeq,
        action: 'borrow',
        loanId,
        data: detail,
      };
    });
  }

  repay(cmd: RepayCommand): WriteOutcome {
    return this.ledger.runWrite(() => {
      const loan = this.ledger.loan(cmd.loanId);
      if (!loan) {
        conflictError(REASONS.loan_not_found, 'loan does not exist', { loanId: cmd.loanId });
      }
      if (loan.status !== 'active') {
        const outcome = this.committedConflict(cmd.runId, 'repay', cmd.loanId, REASONS.loan_already_settled, {
          currentStatus: loan.status,
        });
        return outcome;
      }

      const settleTick = this.ledger.bumpTick();
      const settlement = this.ledger.settlement(loan, settleTick);

      if (cmd.amount < settlement.due) {
        conflictError(REASONS.repayment_too_small, 'repayment is below the amount due', {
          loanId: loan.id,
          paid: cmd.amount,
          due: settlement.due,
          interest: settlement.interest,
          tick: settleTick,
        });
      }

      // Atomically win the active loan before moving value.
      const seq = this.ledger.appendCommitLog({
        runId: cmd.runId,
        tick: settleTick,
        action: 'repay',
        loanId: loan.id,
        result: 'ok',
        reason: null,
        detail: { phase: 'claim' },
      });
      const won = this.ledger.settleLoanIfActive(loan.id, settleTick, 'repaid', seq);
      if (!won) {
        return this.alreadySettledOutcome(cmd.runId, 'repay', loan.id, settleTick);
      }

      const change = cmd.amount - settlement.due;
      this.ledger.addBalance(cmd.payer, -cmd.amount);
      this.ledger.addBalance(LENDER_POOL, settlement.due);
      if (change > 0) this.ledger.addBalance(cmd.payer, change);
      this.ledger.transferNft(loan.token_id, loan.borrower);

      const detail = {
        loanId: loan.id,
        paid: cmd.amount,
        due: settlement.due,
        interest: settlement.interest,
        refund: change,
        settledTick: settleTick,
        tokenReturnedTo: loan.borrower,
      };
      this.ledger.db.prepare('UPDATE commit_log SET detail = ? WHERE seq = ?').run(JSON.stringify(detail), seq);

      return {
        status: 'ok',
        httpStatus: 200,
        runId: cmd.runId,
        tick: settleTick,
        commitSeq: seq,
        action: 'repay',
        loanId: loan.id,
        data: detail,
      };
    });
  }

  liquidate(cmd: LiquidateCommand): WriteOutcome {
    return this.ledger.runWrite(() => {
      const loan = this.ledger.loan(cmd.loanId);
      if (!loan) {
        conflictError(REASONS.loan_not_found, 'loan does not exist', { loanId: cmd.loanId });
      }
      if (loan.status !== 'active') {
        return this.committedConflict(cmd.runId, 'liquidate', cmd.loanId, REASONS.loan_already_settled, {
          currentStatus: loan.status,
        });
      }

      const settleTick = this.ledger.bumpTick();
      const settlement = this.ledger.settlement(loan, settleTick);

      if (!isBelowLiquidationLine(settlement.valuation, settlement.due, this.ledger.cfg.liquidationLineBps)) {
        conflictError(REASONS.liquidation_line_not_crossed, 'valuation has not fallen below the liquidation line', {
          loanId: loan.id,
          valuation: settlement.valuation,
          due: settlement.due,
          threshold: settlement.liquidationThreshold,
          tick: settleTick,
        });
      }

      // Commit ordering is the only arbiter for concurrent liquidations.
      const seq = this.ledger.appendCommitLog({
        runId: cmd.runId,
        tick: settleTick,
        action: 'liquidate',
        loanId: loan.id,
        result: 'ok',
        reason: null,
        detail: { phase: 'claim' },
      });
      const won = this.ledger.settleLoanIfActive(loan.id, settleTick, 'liquidated', seq);
      if (!won) {
        return this.alreadySettledOutcome(cmd.runId, 'liquidate', loan.id, settleTick);
      }

      // Collateral transfer and debt elimination happen only after the claim,
      // still in the same SQLite transaction: no observable partial state.
      this.ledger.transferNft(loan.token_id, LENDER_POOL);

      const detail = {
        loanId: loan.id,
        liquidator: cmd.liquidator,
        tokenTransferredTo: LENDER_POOL,
        debtForgiven: settlement.due,
        valuation: settlement.valuation,
        threshold: settlement.liquidationThreshold,
        settledTick: settleTick,
      };
      this.ledger.db.prepare('UPDATE commit_log SET detail = ? WHERE seq = ?').run(JSON.stringify(detail), seq);

      return {
        status: 'ok',
        httpStatus: 200,
        runId: cmd.runId,
        tick: settleTick,
        commitSeq: seq,
        action: 'liquidate',
        loanId: loan.id,
        data: detail,
      };
    });
  }

  private committedConflict(
    runId: string,
    action: string,
    loanId: number,
    reason: string,
    detail: Record<string, unknown>,
  ): WriteOutcome {
    const enriched = { ...detail };
    if (reason === REASONS.loan_already_settled) {
      const current = this.ledger.loan(loanId);
      if (current) {
        enriched.currentStatus = current.status;
        enriched.settledTick = current.settled_tick;
        enriched.winnerCommitSeq = this.winnerSeq(loanId);
      }
    }
    const tick = this.ledger.getTick(); // conflict does not advance logical time
    const commitSeq = this.ledger.appendCommitLog({
      runId,
      tick,
      action,
      loanId,
      result: 'conflict',
      reason,
      detail: enriched,
    });
    return { status: 'conflict', httpStatus: 409, reason, runId, tick, commitSeq, action, loanId, data: enriched };
  }

  private alreadySettledOutcome(runId: string, action: string, loanId: number, tick: number): WriteOutcome {
    const loan = this.ledger.loan(loanId)!;
    return this.committedConflict(runId, action, loanId, REASONS.loan_already_settled, {
      currentStatus: loan.status,
      settledTick: loan.settled_tick,
      winnerCommitSeq: this.winnerSeq(loanId),
      requestTick: tick,
    });
  }

  private winnerSeq(loanId: number): number | null {
    const row = this.ledger.db.prepare('SELECT settle_commit_seq FROM loans WHERE id = ?').get(loanId) as
      | { settle_commit_seq: number | null }
      | undefined;
    return row?.settle_commit_seq ?? null;
  }
}


