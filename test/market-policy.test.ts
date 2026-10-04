import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp, BuiltApp } from '../src/app.js';
import { AppConfig, loadConfig } from '../src/config.js';

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

async function call(app: BuiltApp, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.app.inject({ method, url, payload: payload as never });
  return { status: response.statusCode, body: response.json() };
}

function userMap(reply: { body: any }): Record<string, { balance: number }> {
  return Object.fromEntries(
    reply.body.users.map((user: { id: string; balance: number }) => [user.id, user]),
  );
}

describe('soulbound policy', () => {
  it('server rejects listing and accept with policy reasons distinct from state conflict', async () => {
    const app = await makeApp();
    try {
      const firstControl = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-zero-royalty',
        tokenId: 'tok-zero',
        sellerId: 'u-bob',
        price: 10,
      });
      assert.equal(firstControl.status, 201);
      const duplicateControl = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-zero-royalty',
        tokenId: 'tok-zero',
        sellerId: 'u-bob',
        price: 10,
      });

      const listSoul = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-soul',
        tokenId: 'tok-soul',
        sellerId: 'u-alice',
        price: 1000,
      });
      assert.equal(listSoul.status, 409);
      assert.equal(listSoul.body.error.category, 'policy');
      assert.equal(listSoul.body.error.reason, 'policy.soulbound_listing');
      assert.equal(duplicateControl.status, 409);
      assert.equal(duplicateControl.body.error.category, 'state');
      assert.notEqual(listSoul.body.error.category, duplicateControl.body.error.category);
      assert.notEqual(listSoul.body.error.reason, duplicateControl.body.error.reason);

      const acceptSoul = await call(app, 'POST', '/orders/ord-seeded-soul/accept', {
        buyerId: 'u-bob',
      });
      assert.equal(acceptSoul.status, 409);
      assert.equal(acceptSoul.body.error.category, 'policy');
      assert.equal(acceptSoul.body.error.reason, 'policy.soulbound_accept');

      const token = await call(app, 'GET', '/tokens/col-soul/tok-soul');
      assert.equal(token.body.token.owner, 'u-alice');
      const users = userMap(await call(app, 'GET', '/users'));
      assert.equal(users['u-bob'].balance, 100000);
      assert.equal(users['u-alice'].balance, 100000);
      assert.equal(users['u-soul-treasury'].balance, 0);
    } finally {
      await app.close();
    }
  });
});

describe('input validation', () => {
  it('returns distinguishable 422 reasons for values and unknown assets', async () => {
    const app = await makeApp();
    try {
      const zeroPrice = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-zero',
        sellerId: 'u-bob',
        price: 0,
      });
      assert.equal(zeroPrice.status, 422);
      assert.equal(zeroPrice.body.error.reason, 'input.price_not_positive_integer');

      const fractionalPrice = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-zero',
        sellerId: 'u-bob',
        price: 1.5,
      });
      assert.equal(fractionalPrice.status, 422);
      assert.equal(fractionalPrice.body.error.reason, 'input.price_not_positive_integer');

      const unknownCollection = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-missing',
        tokenId: 'tok-x',
        sellerId: 'u-bob',
        price: 1,
      });
      assert.equal(unknownCollection.status, 422);
      assert.equal(unknownCollection.body.error.reason, 'input.unknown_collection');

      const unknownToken = await call(app, 'POST', '/orders/listings', {
        collectionId: 'col-art',
        tokenId: 'tok-missing',
        sellerId: 'u-bob',
        price: 1,
      });
      assert.equal(unknownToken.status, 422);
      assert.equal(unknownToken.body.error.reason, 'input.unknown_token');

      const badBps = await call(app, 'POST', '/admin/collections/col-art/royalty', {
        royaltyBps: 10001,
      });
      assert.equal(badBps.status, 422);
      assert.equal(badBps.body.error.reason, 'input.bps_out_of_range');


      const malformed = await app.app.inject({
        method: 'POST',
        url: '/orders/listings',
        headers: { 'content-type': 'application/json' },
        payload: '{ bad json',
      });
      const malformedBody = malformed.json();
      assert.equal(malformed.statusCode, 422);
      assert.equal(malformedBody.error.reason, 'input.bad_type');
      const unknownOrder = await call(app, 'POST', '/orders/ord-missing/cancel', {
        requesterId: 'u-alice',
      });
      assert.equal(unknownOrder.status, 422);
      assert.equal(unknownOrder.body.error.reason, 'input.unknown_order');
    } finally {
      await app.close();
    }
  });
});
