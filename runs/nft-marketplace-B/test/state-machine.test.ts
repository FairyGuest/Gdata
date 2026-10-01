import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestContext, errorBody, seededBalance } from './helpers.ts';

test('list happy path returns 201 with collection snapshot', async () => {
  const ctx = createTestContext();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/orders',
    payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { order: { id: string; status: string; royaltyBps: number; royaltyRecipient: string; price: number } };
  assert.equal(body.order.status, 'open');
  assert.equal(body.order.price, 500);
  assert.equal(body.order.royaltyBps, 250);
  assert.equal(body.order.royaltyRecipient, 'acct-royalty-art');
});

test('duplicate listing -> 409 duplicate_listing', async () => {
  const ctx = createTestContext();
  await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const res = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 600 } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'state');
  assert.equal(err.reason, 'duplicate_listing');
});

test('cancel by non-creator -> 409 not_order_creator', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const res = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/cancel', payload: { actorId: 'bob' } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'state');
  assert.equal(err.reason, 'not_order_creator');
});

test('cancel by creator -> 200, re-cancel -> 409 order_not_open', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const cancelled = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/cancel', payload: { actorId: 'alice' } });
  assert.equal(cancelled.statusCode, 200);
  assert.equal((cancelled.json() as { order: { status: string } }).order.status, 'cancelled');
  const again = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/cancel', payload: { actorId: 'alice' } });
  assert.equal(again.statusCode, 409);
  assert.equal(errorBody(again).reason, 'order_not_open');
});

test('filled order cannot be cancelled -> 409 order_not_open', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const accepted = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  assert.equal(accepted.statusCode, 200);
  const res = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/cancel', payload: { actorId: 'alice' } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'state');
  assert.equal(err.reason, 'order_not_open');
});

test('the three 409 reasons are mutually distinguishable', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 500 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const dup = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 1 } });
  const notCreator = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/cancel', payload: { actorId: 'bob' } });
  await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  const cancelFilled = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/cancel', payload: { actorId: 'alice' } });
  const reasons = [errorBody(dup).reason, errorBody(notCreator).reason, errorBody(cancelFilled).reason];
  assert.deepEqual(reasons, ['duplicate_listing', 'not_order_creator', 'order_not_open']);
  assert.equal(new Set(reasons).size, 3);
});

test('invalid prices -> 422 invalid_price', async () => {
  const ctx = createTestContext();
  for (const price of [0, -3, 2.5, '100', null]) {
    const res = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price } });
    assert.equal(res.statusCode, 422, 'price=' + String(price));
    assert.equal(errorBody(res).reason, 'invalid_price');
  }
});

test('unknown token / seller / order / buyer -> 422 with distinct reasons', async () => {
  const ctx = createTestContext();
  const badToken = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'nope', sellerId: 'alice', price: 1 } });
  assert.equal(badToken.statusCode, 422);
  assert.equal(errorBody(badToken).reason, 'unknown_token');

  const badSeller = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'nobody', price: 1 } });
  assert.equal(badSeller.statusCode, 422);
  assert.equal(errorBody(badSeller).reason, 'unknown_user');

  const badOrder = await ctx.app.inject({ method: 'POST', url: '/orders/ord-999/cancel', payload: { actorId: 'alice' } });
  assert.equal(badOrder.statusCode, 422);
  assert.equal(errorBody(badOrder).reason, 'unknown_order');

  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 1 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const badBuyer = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'nobody' } });
  assert.equal(badBuyer.statusCode, 422);
  assert.equal(errorBody(badBuyer).reason, 'unknown_user');
});

test('insufficient balance -> 409 insufficient_balance', async () => {
  const ctx = createTestContext();
  const daveBalance = seededBalance(ctx, 'dave');
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: daveBalance + 1 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const res = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'dave' } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'state');
  assert.equal(err.reason, 'insufficient_balance');
  assert.equal(ctx.ledger.getBalance('dave'), daveBalance);
  assert.equal(ctx.ledger.getToken('art-1')?.ownerId, 'alice');
});

test('seller no longer owns token at accept -> 409 seller_not_owner and order lapses', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 100 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  ctx.ledger.db.exec("UPDATE tokens SET owner_id = 'carol' WHERE id = 'art-1'");
  const res = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  assert.equal(res.statusCode, 409);
  const err = errorBody(res);
  assert.equal(err.category, 'state');
  assert.equal(err.reason, 'seller_not_owner');
  assert.equal(ctx.ledger.getOrder(orderId)?.status, 'cancelled');
  const events = ctx.journal.eventsFor(orderId);
  assert.ok(events.some((e) => e.transition === 'open->cancelled' && e.reason === 'seller_not_owner'));
  assert.equal(ctx.ledger.getBalance('bob'), seededBalance(ctx, 'bob'));
});
