import { ErrorReason, MarketError } from '../errors.js';
import { SqliteLedger } from '../state/sqlite-ledger.js';
import { validateBps } from '../contract/primitives.js';

export interface OperationContext {
  runId: string;
}

export class AdminService {
  constructor(private readonly ledger: SqliteLedger) {}

  async updateCollectionRoyalty(
    input: { collectionId: string; royaltyBps: number; reason: string },
    context: OperationContext,
  ) {
    validateBps(input.royaltyBps, 'royaltyBps');
    return this.ledger.withTransaction({
      runId: context.runId,
      kind: 'collection_config_update',
      refId: input.collectionId,
      initialDetail: { request: input },
      work: (tx) => {
        const collection = tx.getCollection(input.collectionId);
        if (!collection) {
          throw new MarketError(
            'input',
            ErrorReason.UnknownCollection,
            'Unknown collection',
            { collectionId: input.collectionId },
          );
        }
        const next = tx.updateCollectionRoyalty({
          collection,
          royaltyBps: input.royaltyBps,
          reason: input.reason,
        });
        return {
          runId: context.runId,
          commitSeq: tx.commitSeq,
          previous: { royaltyBps: collection.royaltyBps, version: collection.version },
          collection: next,
          basis: 'current collection config changes; existing orders retain their snapshots',
        };
      },
    });
  }

  async transferTokenForTest(
    input: { collectionId: string; tokenId: string; from: string; nextOwner: string; reason: string },
    context: OperationContext,
  ) {
    return this.ledger.withTransaction({
      runId: context.runId,
      kind: 'test_ownership_transfer',
      refId: input.collectionId + '/' + input.tokenId,
      initialDetail: { request: input },
      work: (tx) => {
        const token = tx.getToken(input.collectionId, input.tokenId);
        if (!token) {
          throw new MarketError(
            'input',
            ErrorReason.UnknownToken,
            'Unknown token',
            { collectionId: input.collectionId, tokenId: input.tokenId },
          );
        }
        if (token.owner !== input.from) {
          throw new MarketError(
            'state',
            ErrorReason.SellerNotHolder,
            'Test transfer source is not the current owner',
            {
              collectionId: input.collectionId,
              tokenId: input.tokenId,
              expectedHolder: token.owner,
              from: input.from,
            },
          );
        }
        const next = tx.transferTokenForTest({
          token,
          nextOwner: input.nextOwner,
          reason: input.reason,
        });
        return {
          runId: context.runId,
          commitSeq: tx.commitSeq,
          token: next,
          basis: 'deterministic fixture control operation; no external participant is used',
        };
      },
    });
  }
}