// Diagnostic read-only surface. Every response carries appliedSeq so that
// ownership and stats are always attributable to one consistent snapshot.

import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { getAppliedSeq, getOwner, getStats, listLastSales, listOwnership, listRejections } from '../state/db.ts';

export function registerDiagRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get('/diag/status', async () => ({
    appliedSeq: getAppliedSeq(db),
  }));

  app.get('/diag/owner/:tokenId', async (req) => {
    const { tokenId } = req.params as { tokenId: string };
    return {
      appliedSeq: getAppliedSeq(db),
      tokenId,
      owner: getOwner(db, tokenId),
    };
  });

  app.get('/diag/stats', async () => ({
    appliedSeq: getAppliedSeq(db),
    ...getStats(db),
  }));

  app.get('/diag/projection', async () => ({
    appliedSeq: getAppliedSeq(db),
    owners: listOwnership(db),
    stats: getStats(db),
    lastSale: listLastSales(db),
  }));

  app.get('/diag/rejections', async () => ({
    appliedSeq: getAppliedSeq(db),
    rejections: listRejections(db),
  }));
}
