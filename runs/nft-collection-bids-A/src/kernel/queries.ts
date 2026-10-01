import type { SqliteEngine } from "../state/sqlite-engine.js";
import { ledgerRepo, type CommitRow } from "../state/ledger-repo.js";
import type { BidRow, TokenRow, AccountRow, CollectionRow } from "../contract/models.js";

export interface BidView {
  readonly bid: BidRow;
  readonly transitions: readonly CommitRow[];
  readonly royaltyPayments: ReadonlyArray<{ readonly commitSeq: number; readonly payeeUserId: string; readonly amount: number }>;
}

export class LedgerQueries {
  constructor(private readonly engine: SqliteEngine) {
  }

  getBid(bidId: string): Promise<BidView | null> {
    return this.engine.read((db) => {
      const bid = ledgerRepo.findBid(db, bidId);
      if (!bid) return null;
      return {
        bid,
        transitions: ledgerRepo.listCommits(db, bidId),
        royaltyPayments: ledgerRepo.listRoyaltyPayments(db, bidId),
      };
    });
  }

  listBids(collectionId?: string): Promise<readonly BidRow[]> {
    return this.engine.read((db) =>
      collectionId ? ledgerRepo.listBidsByCollection(db, collectionId) : ledgerRepo.listBids(db),
    );
  }

  getCollection(collectionId: string): Promise<CollectionRow | null> {
    return this.engine.read((db) => ledgerRepo.findCollection(db, collectionId));
  }

  listCollections(): Promise<readonly CollectionRow[]> {
    return this.engine.read((db) =>
      ["col_punks", "col_apes"]
        .map((id) => ledgerRepo.findCollection(db, id))
        .filter((collection): collection is CollectionRow => collection !== null),
    );
  }

  getToken(tokenId: string): Promise<TokenRow | null> {
    return this.engine.read((db) => ledgerRepo.findToken(db, tokenId));
  }

  listAccounts(): Promise<readonly AccountRow[]> {
    return this.engine.read((db) => ledgerRepo.listAccounts(db));
  }

  getAccount(userId: string): Promise<AccountRow | null> {
    return this.engine.read((db) => ledgerRepo.findAccount(db, userId));
  }

  ledgerTotals(): Promise<{ available: number; frozen: number }> {
    return this.engine.read((db) => ledgerRepo.ledgerTotals(db));
  }

  recentCommits(limit = 100): Promise<readonly CommitRow[]> {
    return this.engine.read((db) => ledgerRepo.listAllCommits(db, limit));
  }
}
