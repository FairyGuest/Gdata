import type { DB } from "../state/db.js";

export interface TransitionRow {
  seq: number;
  token_id: number;
  kind: string;
  amount: number;
  from_level: number;
  to_level: number;
  xp_after: number;
}

/** Read-only level/transition history, ordered by internal commit sequence. */
export function getHistory(db: DB, tokenId: number): TransitionRow[] {
  return db
    .prepare("SELECT seq, token_id, kind, amount, from_level, to_level, xp_after FROM transitions WHERE token_id = ? ORDER BY seq")
    .all(tokenId) as unknown as TransitionRow[];
}

/** Ledger totals for conservation checks: sum(fed) = sum(consumed) + xp. */
export function getLedger(db: DB, tokenId: number) {
  return db
    .prepare("SELECT token_id, level, xp, total_fed, total_consumed FROM tokens WHERE token_id = ?")
    .get(tokenId);
}
