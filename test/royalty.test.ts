import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestContext, seededBalance } from './helpers.ts';

test('royalty split with non-divisible price: 1003 @ 250bps -> royalty 25, seller 978', async () => {
  const ctx = createTestContext();
  const alice0 = seededBalance(ctx, 'alice');
  const bob0 = seededBalance(ctx, 'bob');

  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-1', sellerId: 'alice', price: 1003 } });
  assert.equal(created.statusCode, 201);
  const orderId = (created.json() as { order: { id: string } }).order.id;

  const accepted = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  assert.equal(accepted.statusCode, 200);
  const { fill } = accepted.json() as { fill: { price: number; royalty: number; sellerProceeds: number; newOwner: string; royaltyRecipient: string } };

  // Expected values are literals derived by hand, then cross-checked with
  // an independent recomputation of the rule.
  assert.equal(fill.price, 1003);
  assert.equal(fill.royalty, 25);
  assert.equal(fill.sellerProceeds, 978);
  assert.equal(fill.royalty, Math.floor((1003 * 250) / 10000));
  assert.equal(fill.sellerProceeds, 1003 - 25);
  assert.equal(fill.royalty + fill.sellerProceeds, fill.price);
  assert.equal(fill.newOwner, 'bob');
  assert.equal(fill.royaltyRecipient, 'acct-royalty-art');

  // Buyer always pays exactly price; seller and royalty accounts credited per split.
  assert.equal(ctx.ledger.getBalance('bob'), bob0 - 1003);
  assert.equal(ctx.ledger.getBalance('alice'), alice0 + 978);
  assert.equal(ctx.ledger.getBalance('acct-royalty-art'), 25);
  assert.equal(ctx.ledger.getToken('art-1')?.ownerId, 'bob');

  // The persisted fill (commit snapshot) matches the response exactly.
  const persisted = ctx.ledger.getFill(orderId);
  assert.ok(persisted);
  assert.equal(persisted.price, fill.price);
  assert.equal(persisted.royalty, fill.royalty);
  assert.equal(persisted.sellerProceeds, fill.sellerProceeds);
});

test('split uses listing-time snapshot; later collection edits do not apply', async () => {
  const ctx = createTestContext();
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'art-2', sellerId: 'alice', price: 2000 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;

  // Mutate the collection after the listing exists.
  ctx.ledger.db.exec("UPDATE collections SET royalty_bps = 9000, royalty_recipient = 'acct-royalty-zero' WHERE id = 'col-art'");

  const accepted = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'carol' } });
  assert.equal(accepted.statusCode, 200);
  const { fill } = accepted.json() as { fill: { royalty: number; sellerProceeds: number; royaltyRecipient: string } };
  // Snapshot was 250 bps -> royalty 50, not 9000 bps -> 1800.
  assert.equal(fill.royalty, 50);
  assert.equal(fill.sellerProceeds, 1950);
  assert.equal(fill.royaltyRecipient, 'acct-royalty-art');
  assert.equal(ctx.ledger.getBalance('acct-royalty-art'), 50);
  assert.equal(ctx.ledger.getBalance('acct-royalty-zero'), 0);
});

test('zero-royalty collection: buyer pays price, seller gets everything', async () => {
  const ctx = createTestContext();
  const alice0 = seededBalance(ctx, 'alice');
  const bob0 = seededBalance(ctx, 'bob');
  const created = await ctx.app.inject({ method: 'POST', url: '/orders', payload: { tokenId: 'zero-1', sellerId: 'alice', price: 777 } });
  const orderId = (created.json() as { order: { id: string } }).order.id;
  const accepted = await ctx.app.inject({ method: 'POST', url: '/orders/' + orderId + '/accept', payload: { buyerId: 'bob' } });
  assert.equal(accepted.statusCode, 200);
  const { fill } = accepted.json() as { fill: { royalty: number; sellerProceeds: number } };
  assert.equal(fill.royalty, 0);
  assert.equal(fill.sellerProceeds, 777);
  assert.equal(ctx.ledger.getBalance('alice'), alice0 + 777);
  assert.equal(ctx.ledger.getBalance('bob'), bob0 - 777);
  assert.equal(ctx.ledger.getBalance('acct-royalty-zero'), 0);
});
