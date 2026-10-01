/**
 * Kernel conservation predicates. These are intentionally independent from
 * SQLite update logic and use signed 64-bit-safe BigInt arithmetic.
 */

import { RoyaltySplit, UserRecord } from '../contract/types.js';
import { ErrorReason, MarketError } from '../errors.js';

export interface ConservationSnapshot {
  totalBalanceBefore: number;
  totalBalanceAfter: number;
  tokenCountBefore: number;
  tokenCountAfter: number;
  usersBefore: UserRecord[];
  usersAfter: UserRecord[];
}

export function assertRoyaltyConservation(split: RoyaltySplit): void {
  const price = BigInt(split.grossPrice);
  const royalty = BigInt(split.royaltyAmount);
  const seller = BigInt(split.sellerProceeds);
  const expectedRoyalty =
    (price * BigInt(split.royaltyBps)) / 10000n;

  const basis = [
    'royalty=floor(price*bps/10000)',
    'seller=price-royalty',
    'royalty+seller=price',
  ].join('; ');

  if (
    royalty !== expectedRoyalty ||
    seller !== price - royalty ||
    royalty + seller !== price
  ) {
    throw new MarketError(
      'computation',
      ErrorReason.ConservationViolation,
      'Royalty split conservation assertion failed',
      { split, expectedRoyalty: expectedRoyalty.toString() },
      { basis },
    );
  }
}

export function assertLedgerConservation(snapshot: ConservationSnapshot): void {
  const before = BigInt(snapshot.totalBalanceBefore);
  const after = BigInt(snapshot.totalBalanceAfter);
  const beforeById = new Map(snapshot.usersBefore.map((user) => [user.id, BigInt(user.balance)]));
  const afterById = new Map(snapshot.usersAfter.map((user) => [user.id, BigInt(user.balance)]));
  const accountDeltas = [...beforeById.keys()].map((id) => ({
    id,
    delta: (afterById.get(id) ?? 0n) - (beforeById.get(id) ?? 0n),
  }));
  const deltaSum = accountDeltas.reduce((sum, item) => sum + item.delta, 0n);

  const basis = [
    'sum(balance_after)=sum(balance_before)',
    'sum(account_deltas)=0',
    'token_count_before=token_count_after',
  ].join('; ');

  if (
    before !== after ||
    deltaSum !== 0n ||
    snapshot.tokenCountBefore !== snapshot.tokenCountAfter
  ) {
    throw new MarketError(
      'computation',
      ErrorReason.ConservationViolation,
      'Ledger conservation assertion failed',
      {
        totalBalanceBefore: snapshot.totalBalanceBefore,
        totalBalanceAfter: snapshot.totalBalanceAfter,
        tokenCountBefore: snapshot.tokenCountBefore,
        tokenCountAfter: snapshot.tokenCountAfter,
        accountDeltas: accountDeltas.map((item) => ({
          id: item.id,
          delta: item.delta.toString(),
        })),
      },
      { basis },
    );
  }
}