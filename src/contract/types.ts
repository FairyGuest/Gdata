export type LoanStatus = 'active' | 'repaid' | 'liquidated';

export interface BorrowCommand {
  kind: 'borrow';
  runId: string;
  borrower: string;
  tokenId: string;
  amount: number;
}

export interface RepayCommand {
  kind: 'repay';
  runId: string;
  loanId: number;
  payer: string;
  amount: number;
}

export interface LiquidateCommand {
  kind: 'liquidate';
  runId: string;
  loanId: number;
  liquidator: string;
}

export type WriteCommand = BorrowCommand | RepayCommand | LiquidateCommand;

export interface SettlementView {
  tick: number;
  principal: number;
  elapsedTicks: number;
  perTickBps: number;
  interest: number;
  due: number;
  valuation: number;
  liquidationThreshold: number;
  liquidatable: boolean;
}

export interface LoanView {
  loanId: number;
  borrower: string;
  tokenId: string;
  principal: number;
  openedTick: number;
  status: LoanStatus;
  settledTick: number | null;
  settlement: SettlementView | null;
}
