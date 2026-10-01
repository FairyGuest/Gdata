import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestContext, errorBody, seededBalance } from './helpers.ts';

test('listing a soulbound token -> 409 policy soulbound_transfer', async () => {
  const ctx = createTestContext();
  const res = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'soul-1', sellerId: 'alice', price: 100 } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'policy');
  assert.equal(err.reason, 'soulbound_transfer');
  assert.equal(ctx.ledger.getOpenOrderForToken('soul-1'), undefined);
});

test('accepting an order whose collection turned soulbound -> 409 policy soulbound_transfer', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'zero-1', sellerId: 'alice', price: 100 } });
  assert.equal(created.statusCode, 201);
  const orderId = (created.json() as { order: { id: string } }).order.id;

  ctx.ledger.db.exec("UPDATE collections SET soulbound = 1 WHERE id = 'col-zero'");

  const res = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'policy');
  assert.equal(err.reason, 'soulbound_transfer');
  // No transfer, no payment.
  assert.equal(ctx.ledger.getToken('zero-1')?.ownerId, 'alice');
  assert.equal(ctx.ledger.getBalance('bob'), seededBalance(ctx, 'bob'));
});

test('policy conflicts are distinguishable from state conflicts', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 100 } });
  assert.equal(created.statusCode, 201);
  const dup = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 100 } });
  const soul = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'soul-2', sellerId: 'bob', price: 100 } });
  assert.equal(dup.statusCode, 409);
  assert.equal(soul.statusCode, 409);
  const dupErr = errorBody(dup);
  const soulErr = errorBody(soul);
  assert.notEqual(dupErr.category, soulErr.category);
  assert.equal(dupErr.category, 'state');
  assert.equal(soulErr.category, 'policy');
  assert.notEqual(dupErr.reason, soulErr.reason);
});
