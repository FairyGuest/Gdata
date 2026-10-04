import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, BuiltApp } from '../src/app.js';
import { AppConfig, loadConfig } from '../src/config.js';
import { computeRoyaltySplit } from '../src/kernel/royalty.js';

async function makeApp(overrides: Partial<AppConfig> = {}): Promise<BuiltApp> {
  const config: AppConfig = {
    ...loadConfig(),
    dbPath: ':memory:',
    lockWaitMs: 500,
    diagConsole: false,
    diagLogPath: null,
    ...overrides,
  };
  return buildApp(config);
}

interface HttpReply {
  status: number;
  body: any;
}

async function call(
  app: BuiltApp,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<HttpReply> {
  const response = await app.app.inject({ method, url, payload: payload as never });
  return { status: response.statusCode, body: response.json() };
}

function userMap(reply: HttpReply): Record<string, { balance: number }> {
  return Object.fromEntries(
    reply.body.users.map((user: { id: string; balance: number }) => [user.id, user]),
  );
}

function totalBalance(users: Record<string, { balance: number }>): number {
  return Object.values(users).reduce((total, user) => total + user.balance, 0);
}

function sum(entries: Array<{ amount: number }>): number {
  return entries.reduce((total, item) => total + item.amount, 0);
}

describe('independent royalty arithmetic', () => {
  it('floors non-divisible royalty and returns price minus royalty', () => {
    const price = 1003n;
    const bps = 250n;
    const expectedRoyalty = (price * bps) / 10000n;
    const expectedSeller = price - expectedRoyalty;
    assert.equal(expectedRoyalty, 25n);
    assert.equal(expectedSeller, 978n);

    const split = computeRoyaltySplit(Number(price), Number(bps));
    assert.equal(split.royaltyAmount, Number(expectedRoyalty));
    assert.equal(split.sellerProceeds, Number(expectedSeller));
    assert.equal(split.royaltyAmount + split.sellerProceeds, split.grossPrice);
  });
});

describe('royalty settlement and snapshot', () => {
  it('uses listing snapshot after collection bps later changes', async () => {
    const app = await makeApp();
    try {
      const list = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-royalty',
        sellerId: 'u-alice',
        price: 1003,
      });
      assert.equal(list.status, 201);
      const orderId = list.body.order.id;
      assert.equal(list.body.snapshot.royaltyBps, 250);

      const update = await call(app, 'POST', '/admin/collections/col-art/royalty', {
        royaltyBps: 1000,
        reason: 'snapshot-test',
      });
      assert.equal(update.status, 200);
      assert.equal(update.body.collection.royaltyBps, 1000);

      const before = userMap(await call(app, 'GET', '/users'));
      const accept = await call(app, 'POST', '/orders/' + orderId + '/accept', {
        buyerId: 'u-bob',
      });
      assert.equal(accept.status, 200, JSON.stringify(accept.body));
      const after = userMap(await call(app, 'GET', '/users'));

      assert.equal(accept.body.newOwner, 'u-bob');
      assert.equal(accept.body.price, 1003);
      assert.equal(accept.body.split.royaltyBps, 250);
      assert.equal(accept.body.split.royaltyAmount, 25);
      assert.equal(accept.body.split.sellerProceeds, 978);
      assert.equal(accept.body.order.royaltyBpsSnapshot, 250);
      assert.equal(app.ledger.findCollection('col-art')?.royaltyBps, 1000);
      assert.equal(after['u-bob'].balance - before['u-bob'].balance, -1003);
      assert.equal(after['u-alice'].balance - before['u-alice'].balance, 978);
      assert.equal(after['u-treasury'].balance - before['u-treasury'].balance, 25);
      assert.equal(totalBalance(before), totalBalance(after));

      const transfers = await call(app, 'GET', '/diag/transfers?orderId=' + orderId);
      const entries = transfers.body.transfers;
      assert.equal(sum(entries.filter((item: any) => item.direction === 'debit')), 1003);
      assert.equal(sum(entries.filter((item: any) => item.direction === 'credit')), 1003);

      const run = await call(app, 'GET', '/diag/runs/' + accept.body.runId);
      assert.equal(run.body.run.decision, 'accepted');
      assert.equal(run.body.run.settlement.royaltyAmount, 25);
      assert.match(run.body.run.basis, /commit sequence/);
    } finally {
      await app.close();
    }
  });
});

describe('concurrent accept arbitration', () => {
  it('allows exactly one buyer by committed transaction sequence', async () => {
    const app = await makeApp();
    try {
      const list = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-concurrent',
        sellerId: 'u-alice',
        price: 1000,
      });
      assert.equal(list.status, 201);
      const orderId = list.body.order.id;
      const before = userMap(await call(app, 'GET', '/users'));

      const replies = await Promise.all([
        call(app, 'POST', '/orders/' + orderId + '/accept', { buyerId: 'u-bob' }),
        call(app, 'POST', '/orders/' + orderId + '/accept', { buyerId: 'u-carol' }),
      ]);
      const success = replies.filter((reply) => reply.status === 200);
      const conflicts = replies.filter((reply) => reply.status === 409);
      assert.equal(success.length, 1);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].body.error.category, 'state');
      assert.equal(conflicts[0].body.error.reason, 'conflict.order_already_filled');

      const winner = success[0].body;
      const token = await call(app, 'GET', '/tokens/col-art/tok-concurrent');
      assert.equal(token.body.token.owner, winner.buyer);
      assert.equal(winner.order.status, 'filled');
      assert.equal(winner.order.filledCommitSeq, winner.commitSeq);

      const after = userMap(await call(app, 'GET', '/users'));
      assert.equal(totalBalance(before), totalBalance(after));
      assert.equal(after[winner.buyer].balance, 99000);
      assert.equal(after['u-alice'].balance - before['u-alice'].balance, 975);
      assert.equal(after['u-treasury'].balance - before['u-treasury'].balance, 25);

      const commits = await call(app, 'GET', '/diag/commits');
      const acceptCommits = commits.body.commits.filter((item: any) => item.kind === 'order_accept');
      assert.equal(acceptCommits.length, 1);
      const transfers = await call(app, 'GET', '/diag/transfers?orderId=' + orderId);
      assert.equal(transfers.body.transfers.length, 3);
      assert.equal(sum(transfers.body.transfers.filter((item: any) => item.direction === 'debit')), 1000);
      assert.equal(sum(transfers.body.transfers.filter((item: any) => item.direction === 'credit')), 1000);
    } finally {
      await app.close();
    }
  });
});

describe('order state machine boundaries', () => {
  it('distinguishes duplicate listing, non-creator cancel, and cancel after fill', async () => {
    const app = await makeApp();
    try {
      const list = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-cancel',
        sellerId: 'u-alice',
        price: 1234,
      });
      assert.equal(list.status, 201);
      const orderId = list.body.order.id;

      const duplicate = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-cancel',
        sellerId: 'u-alice',
        price: 999,
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.category, 'state');
      assert.equal(duplicate.body.error.reason, 'conflict.duplicate_listing');

      const nonCreator = await call(app, 'POST', '/orders/' + orderId + '/cancel', {
        requesterId: 'u-bob',
      });
      assert.equal(nonCreator.status, 409);
      assert.equal(nonCreator.body.error.category, 'state');
      assert.equal(nonCreator.body.error.reason, 'conflict.not_order_creator');
      assert.notEqual(nonCreator.body.error.reason, duplicate.body.error.reason);

      const accept = await call(app, 'POST', '/orders/' + orderId + '/accept', {
        buyerId: 'u-bob',
      });
      assert.equal(accept.status, 200);

      const cancelFilled = await call(app, 'POST', '/orders/' + orderId + '/cancel', {
        requesterId: 'u-alice',
      });
      assert.equal(cancelFilled.status, 409);
      assert.equal(cancelFilled.body.error.category, 'state');
      assert.equal(cancelFilled.body.error.reason, 'conflict.order_already_filled');
      assert.notEqual(cancelFilled.body.error.reason, duplicate.body.error.reason);
      assert.notEqual(cancelFilled.body.error.reason, nonCreator.body.error.reason);

      const order = await call(app, 'GET', '/orders');
      assert.equal(order.body.orders.find((item: any) => item.id === orderId).status, 'filled');
    } finally {
      await app.close();
    }
  });

  it('supports creator cancel and then a new listing', async () => {
    const app = await makeApp();
    try {
      const list = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-non-creator',
        sellerId: 'u-alice',
        price: 10,
      });
      const orderId = list.body.order.id;
      const cancel = await call(app, 'POST', '/orders/' + orderId + '/cancel', {
        requesterId: 'u-alice',
      });
      assert.equal(cancel.status, 200);
      assert.deepEqual(cancel.body.transition, { from: 'active', to: 'cancelled' });

      const cancelAgain = await call(app, 'POST', '/orders/' + orderId + '/cancel', {
        requesterId: 'u-alice',
      });
      assert.equal(cancelAgain.status, 409);
      assert.equal(cancelAgain.body.error.reason, 'conflict.order_already_cancelled');

      const relist = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-non-creator',
        sellerId: 'u-alice',
        price: 11,
      });
      assert.equal(relist.status, 201);
      assert.notEqual(relist.body.order.id, orderId);
    } finally {
      await app.close();
    }
  });
});

describe('seller must still hold token at accept commit', () => {
  it('invalidates an active listing when ownership moves before accept', async () => {
    const app = await makeApp();
    try {
      const list = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-move',
        sellerId: 'u-alice',
        price: 100,
      });
      assert.equal(list.status, 201);
      const orderId = list.body.order.id;

      const move = await call(app, 'POST', '/admin/tokens/col-art/tok-move/transfer', {
        from: 'u-alice',
        nextOwner: 'u-carol',
      });
      assert.equal(move.status, 200);

      const accept = await call(app, 'POST', '/orders/' + orderId + '/accept', {
        buyerId: 'u-bob',
      });
      assert.equal(accept.status, 409);
      assert.equal(accept.body.error.category, 'state');
      assert.equal(accept.body.error.reason, 'conflict.seller_not_holder');
      assert.equal(accept.body.error.details.currentHolder, 'u-carol');

      const users = userMap(await call(app, 'GET', '/users'));
      assert.equal(users['u-bob'].balance, 100000);
      assert.equal(users['u-alice'].balance, 100000);
      assert.equal(users['u-treasury'].balance, 0);
    } finally {
      await app.close();
    }
  });
});

describe('insufficient buyer balance', () => {
  it('rejects accept with a distinct state conflict reason', async () => {
    const app = await makeApp();
    try {
      const list = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-poor-buyer',
        sellerId: 'u-alice',
        price: 100,
      });
      const accept = await call(app, 'POST', '/orders/' + list.body.order.id + '/accept', {
        buyerId: 'u-broke',
      });
      assert.equal(accept.status, 409);
      assert.equal(accept.body.error.category, 'state');
      assert.equal(accept.body.error.reason, 'conflict.insufficient_balance');
      assert.equal(accept.body.error.details.balance, 5);
      assert.equal(accept.body.error.details.required, 100);
    } finally {
      await app.close();
    }
  });
});
