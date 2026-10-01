import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestContext, errorBody, seededBalance } from './helpers.ts';

test('concurrent double accept: exactly one 200 and one 409, single transfer, conservation holds', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;

  const [resA, resB] = await Promise.all([
    ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } }),
    ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'carol' } }),
  ]);
  const statuses = [resA.statusCode, resB.statusCode].sort();
  assert.deepEqual(statuses, [200, 409]);

  const winner = resA.statusCode === 200 ? resA : resB;
  const loser = resA.statusCode === 200 ? resB : resA;
  const fill = (winner.json() as { fill: { buyerId: string; commitSeq: number } }).fill;
  const err = errorBody(loser);
  assert.equal(err.category, 'state');
  assert.equal(err.reason, 'order_not_open');

  // Ownership transferred exactly once, to the winning buyer.
  assert.equal(ctx.ledger.getToken('art-1')?.ownerId, fill.buyerId);
  assert.equal(ctx.ledger.countFills(), 1);
  assert.equal(ctx.ledger.getOrder(orderId)?.status, 'filled');
  assert.equal(ctx.ledger.getOrder(orderId)?.commitSeq, fill.commitSeq);

  // Conservation: total balances unchanged vs the seeded sum.
  assert.equal(ctx.ledger.sumBalances(), ctx.manifest.expectedBalanceSum);

  // The loser paid nothing.
  const loserId = fill.buyerId === 'bob' ? 'carol' : 'bob';
  assert.equal(ctx.ledger.getBalance(loserId), seededBalance(ctx, loserId));

  // The winner paid exactly price.
  assert.equal(ctx.ledger.getBalance(fill.buyerId), seededBalance(ctx, fill.buyerId) - 500);
});

test('three-way accept race: exactly one winner, commit sequence advances by one', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-2', sellerId: 'alice', price: 10 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const seqBefore = Number(ctx.ledger.getMeta('commit_seq'));

  const results = await Promise.all(
    ['bob', 'carol', 'dave'].map((buyerId) =>
      ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId } }),
    ),
  );
  const ok = results.filter((r) => r.statusCode === 200);
  const conflicts = results.filter((r) => r.statusCode === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflicts.length, 2);
  for (const c of conflicts) assert.equal(errorBody(c).reason, 'order_not_open');

  assert.equal(Number(ctx.ledger.getMeta('commit_seq')), seqBefore + 1);
  assert.equal(ctx.ledger.countFills(), 1);
  assert.equal(ctx.ledger.sumBalances(), ctx.manifest.expectedBalanceSum);
});
