import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarketError } from '../src/contract/errors.ts';
import { parseCollectionConfig } from '../src/contract/parse.ts';
import { computeSplit } from '../src/kernel/engine.ts';
import { createTestContext, errorBody, seededBalance } from './helpers.ts';

test('contract layer rejects out-of-range bps -> input invalid_bps', () => {
  assert.throws(
    () => parseCollectionConfig({ id: 'c', name: 'c', royaltyBps: 10001, royaltyRecipient: 'r', soulbound: false }),
    (err: unknown) => err instanceof MarketError && err.category === 'input' && err.reason === 'invalid_bps',
  );
  assert.throws(
    () => parseCollectionConfig({ id: 'c', name: 'c', royaltyBps: -1, royaltyRecipient: 'r', soulbound: false }),
    (err: unknown) => err instanceof MarketError && err.reason === 'invalid_bps',
  );
});

test('computeSplit unit: floor semantics', () => {
  assert.deepEqual(computeSplit(1003, 250), { royalty: 25, sellerProceeds: 978 });
  assert.deepEqual(computeSplit(100, 10000), { royalty: 100, sellerProceeds: 0 });
  assert.deepEqual(computeSplit(100, 0), { royalty: 0, sellerProceeds: 100 });
});

test('unknown collection -> 422 unknown_collection', async () => {
  const ctx = createTestContext();
  const res = await ctx.app.inject({ method: 'GET', url: '/collections/nope' });
  assert.equal(res.statusCode, 422);
  assert.equal(errorBody(res).reason, 'unknown_collection');
});

test('storage unavailable -> 503 resource storage_unavailable', async () => {
  const ctx = createTestContext();
  ctx.ledger.close();
  const res = await ctx.app.inject({ method: 'GET', url: '/diag/health' });
  assert.equal(res.statusCode, 503);
  const err = errorBody(res);
  assert.equal(err.category, 'resource');
  assert.equal(err.reason, 'storage_unavailable');
});

test('conservation violation -> 500 internal and the transaction rolls back', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;

  // Sabotage the conservation probe so the kernel detects a drift.
  const original = ctx.ledger.sumBalances.bind(ctx.ledger);
  ctx.ledger.sumBalances = () => original() + 1;

  const res = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  assert.equal(res.statusCode, 500);
  const err = errorBody(res);
  assert.equal(err.category, 'internal');
  assert.equal(err.reason, 'conservation_violation');

  // Everything rolled back: order still open, balances and ownership untouched.
  assert.equal(ctx.ledger.getOrder(orderId)?.status, 'open');
  assert.equal(ctx.ledger.getToken('art-1')?.ownerId, 'alice');
  assert.equal(ctx.ledger.getBalance('bob'), seededBalance(ctx, 'bob'));
  assert.equal(ctx.ledger.countFills(), 0);
});

test('error responses carry run id and request id for replay', async () => {
  const ctx = createTestContext();
  const res = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'nope', sellerId: 'alice', price: 1 } });
  const err = errorBody(res);
  assert.equal(err.runId, ctx.runId);
  assert.match(err.requestId, /^req-run-/);
});
