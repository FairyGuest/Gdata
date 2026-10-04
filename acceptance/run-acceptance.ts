import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp, BuiltApp } from '../src/app.js';
import { AppConfig, loadConfig } from '../src/config.js';

interface Reply {
  status: number;
  body: any;
  runId: string | null;
}

class AcceptanceRunner {
  private step = 0;
  readonly failures: string[] = [];

  constructor(readonly app: BuiltApp) {}

  async request(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Reply> {
    this.step += 1;
    console.log('\n=== STEP ' + String(this.step).padStart(2, '0') + ' ===');
    console.log('REQUEST ' + method + ' ' + url);
    console.log(JSON.stringify(payload ?? null, null, 2));

    const response = await this.app.app.inject({
      method,
      url,
      payload: payload as never,
    });
    const body = response.json();
    const runs = await this.app.app.inject({ method: 'GET', url: '/diag/runs' });
    const runId = runs.json().runs.at(-1)?.runId ?? null;

    console.log('RUN ' + (runId ?? '(none)'));
    console.log('RESPONSE ' + String(response.statusCode));
    console.log(JSON.stringify(body, null, 2));
    return { status: response.statusCode, body, runId };
  }

  check(scenario: string, name: string, condition: boolean, actual: unknown, expected: unknown, basis: string): boolean {
    if (condition) {
      console.log('VERDICT PASS - ' + scenario + ' - ' + name + ' (' + basis + ')');
      return true;
    }
    const message = scenario + ' - ' + name + ' | expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual) + ' | ' + basis;
    console.log('VERDICT FAIL - ' + message);
    this.failures.push(message);
    return false;
  }
}

async function makeApp(overrides: Partial<AppConfig>): Promise<BuiltApp> {
  const config: AppConfig = {
    ...loadConfig(),
    dbPath: ':memory:',
    lockWaitMs: 250,
    diagConsole: false,
    diagLogPath: null,
    ...overrides,
  };
  return buildApp(config);
}

function users(reply: Reply): Record<string, { balance: number }> {
  return Object.fromEntries(
    reply.body.users.map((user: { id: string; balance: number }) => [user.id, user]),
  );
}

function total(records: Record<string, { balance: number }>): number {
  return Object.values(records).reduce((sum, user) => sum + user.balance, 0);
}

function sumTransfers(reply: Reply, direction: 'debit' | 'credit'): number {
  return reply.body.transfers
    .filter((item: { direction: string; amount: number }) => item.direction === direction)
    .reduce((sum: number, item: { amount: number }) => sum + item.amount, 0);
}

async function scenarioRoyalty(run: AcceptanceRunner): Promise<void> {
  const scenario = 'royalty non-divisible and snapshot';
  const before = users(await run.request('GET', '/users'));

  const list = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-royalty',
    sellerId: 'u-alice',
    price: 1003,
  });
  const orderId = list.body.order?.id;
  run.check(scenario, 'listing created', list.status === 201, list.status, 201, 'fixed seed token and positive integer price');
  run.check(scenario, 'snapshot bps is 250', list.body.snapshot?.royaltyBps === 250, list.body.snapshot?.royaltyBps, 250, 'snapshot copied at listing creation');

  const update = await run.request('POST', '/admin/collections/col-art/royalty', {
    royaltyBps: 1000,
    reason: 'prove existing order keeps its snapshot',
  });
  run.check(scenario, 'later collection change commits', update.status === 200, update.status, 200, 'new listings see the changed collection config');

  const accept = await run.request('POST', '/orders/' + orderId + '/accept', { buyerId: 'u-bob' });
  const after = users(await run.request('GET', '/users'));
  const transfers = await run.request('GET', '/diag/transfers?orderId=' + orderId);

  const expectedRoyalty = Number((1003n * 250n) / 10000n);
  const expectedSeller = Number(1003n - BigInt(expectedRoyalty));
  run.check(scenario, 'accept succeeds', accept.status === 200, accept.status, 200, 'single atomic settlement transaction');
  run.check(scenario, 'independent expected royalty is 25', expectedRoyalty === 25, expectedRoyalty, 25, 'independent BigInt floor(price*bps/10000)');
  run.check(scenario, 'royalty amount matches independent arithmetic', accept.body.split?.royaltyAmount === expectedRoyalty, accept.body.split?.royaltyAmount, expectedRoyalty, 'same committed settlement snapshot');
  run.check(scenario, 'seller proceeds are 978', accept.body.split?.sellerProceeds === expectedSeller, accept.body.split?.sellerProceeds, expectedSeller, 'price minus royalty');
  run.check(scenario, 'buyer pays exactly price', after['u-bob'].balance - before['u-bob'].balance === -1003, after['u-bob'].balance - before['u-bob'].balance, -1003, 'buyer debit equals gross price');
  run.check(scenario, 'seller receives 978', after['u-alice'].balance - before['u-alice'].balance === 978, after['u-alice'].balance - before['u-alice'].balance, 978, 'seller credit after royalty');
  run.check(scenario, 'recipient receives 25', after['u-treasury'].balance - before['u-treasury'].balance === 25, after['u-treasury'].balance - before['u-treasury'].balance, 25, 'royalty credit');
  run.check(scenario, 'order keeps old 250 bps snapshot', accept.body.order?.royaltyBpsSnapshot === 250, accept.body.order?.royaltyBpsSnapshot, 250, 'collection change after listing does not mutate order snapshot');
  run.check(scenario, 'new owner is buyer', accept.body.newOwner === 'u-bob', accept.body.newOwner, 'u-bob', 'owner read from the same committed settlement transaction');
  run.check(scenario, 'debit split sums to price', sumTransfers(transfers, 'debit') === 1003, sumTransfers(transfers, 'debit'), 1003, 'buyer debit conservation');
  run.check(scenario, 'credit split sums to price', sumTransfers(transfers, 'credit') === 1003, sumTransfers(transfers, 'credit'), 1003, 'seller proceeds plus royalty');
  run.check(scenario, 'ledger total conserved', total(before) === total(after), total(after), total(before), 'sum of balance deltas is zero');
}

async function scenarioConcurrent(run: AcceptanceRunner): Promise<void> {
  const scenario = 'concurrent double accept commit arbitration';
  const before = users(await run.request('GET', '/users'));
  const list = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-concurrent',
    sellerId: 'u-alice',
    price: 1000,
  });
  const orderId = list.body.order.id;

  const payloads = [
    { buyerId: 'u-bob', label: 'buyer-bob' },
    { buyerId: 'u-carol', label: 'buyer-carol' },
  ];
  console.log('\n=== CONCURRENT ACCEPTS (same internal transaction queue) ===');
  console.log(JSON.stringify(payloads, null, 2));
  const replies = await Promise.all(
    payloads.map(async (payload) => {
      const response = await run.app.app.inject({
        method: 'POST',
        url: '/orders/' + orderId + '/accept',
        payload: { buyerId: payload.buyerId },
      });
      return { label: payload.label, status: response.statusCode, body: response.json() };
    }),
  );
  for (const reply of replies) {
    console.log('RESPONSE ' + reply.label + ' ' + reply.status);
    console.log(JSON.stringify(reply.body, null, 2));
  }
  const successes = replies.filter((reply) => reply.status === 200);
  const conflicts = replies.filter((reply) => reply.status === 409);
  const after = users(await run.request('GET', '/users'));
  const token = await run.request('GET', '/tokens/col-art/tok-concurrent');
  const commits = await run.request('GET', '/diag/commits');
  const transfers = await run.request('GET', '/diag/transfers?orderId=' + orderId);

  run.check(scenario, 'exactly one 200', successes.length === 1, successes.length, 1, 'only one active conditional order update can change one row');
  run.check(scenario, 'exactly one 409', conflicts.length === 1, conflicts.length, 1, 'loser sees filled state at its transaction snapshot');
  run.check(scenario, 'loser reason is order already filled', conflicts[0]?.body.error?.reason === 'conflict.order_already_filled', conflicts[0]?.body.error?.reason, 'conflict.order_already_filled', 'state conflict is not based on request arrival timestamp');
  run.check(scenario, 'owner transfers once', token.body.token.owner === successes[0]?.body.buyer, token.body.token.owner, successes[0]?.body.buyer, 'single token ownership row');
  run.check(scenario, 'one settlement commit exists', commits.body.commits.filter((item: { kind: string; refId: string }) => item.kind === 'order_accept' && item.refId === orderId).length === 1, commits.body.commits.filter((item: { kind: string; refId: string }) => item.kind === 'order_accept' && item.refId === orderId).length, 1, 'internal commit sequence winner is durable');
  run.check(scenario, 'three transfer rows only', transfers.body.transfers.length === 3, transfers.body.transfers.length, 3, 'buyer debit, seller credit, royalty credit');
  run.check(scenario, 'split credits equal price', sumTransfers(transfers, 'credit') === 1000, sumTransfers(transfers, 'credit'), 1000, '900 seller plus 100 royalty after collection config changed for this shared fixture');
  run.check(scenario, 'ledger total conserved', total(before) === total(after), total(after), total(before), 'one buyer debit and two matching credits');
}

async function scenarioSoulbound(run: AcceptanceRunner): Promise<void> {
  const scenario = 'soulbound policy';
  const controlList = await run.request('POST', '/orders/listings', {
    collectionId: 'col-zero-royalty',
    tokenId: 'tok-zero',
    sellerId: 'u-bob',
    price: 7,
  });
  const duplicate = await run.request('POST', '/orders/listings', {
    collectionId: 'col-zero-royalty',
    tokenId: 'tok-zero',
    sellerId: 'u-bob',
    price: 7,
  });
  const listSoul = await run.request('POST', '/orders/listings', {
    collectionId: 'col-soul',
    tokenId: 'tok-soul',
    sellerId: 'u-alice',
    price: 1000,
  });
  const acceptSoul = await run.request('POST', '/orders/ord-seeded-soul/accept', { buyerId: 'u-bob' });
  const token = await run.request('GET', '/tokens/col-soul/tok-soul');

  run.check(scenario, 'ordinary duplicate is state conflict', duplicate.status === 409 && duplicate.body.error.category === 'state', duplicate.body.error, { category: 'state', reason: 'conflict.duplicate_listing' }, 'control conflict category');
  run.check(scenario, 'soulbound listing rejected', listSoul.status === 409, listSoul.status, 409, 'server policy enforced inside listing transaction');
  run.check(scenario, 'soulbound listing category is policy', listSoul.body.error.category === 'policy', listSoul.body.error.category, 'policy', 'independent from ordinary state conflicts');
  run.check(scenario, 'soulbound listing reason distinct', listSoul.body.error.reason === 'policy.soulbound_listing' && listSoul.body.error.reason !== duplicate.body.error.reason, listSoul.body.error.reason, 'policy.soulbound_listing', 'machine distinguishable reason');
  run.check(scenario, 'soulbound accept rejected', acceptSoul.status === 409 && acceptSoul.body.error.category === 'policy', acceptSoul.body.error, { category: 'policy', reason: 'policy.soulbound_accept' }, 'seeded policy snapshot also cannot bypass accept');
  run.check(scenario, 'soul token owner unchanged', token.body.token.owner === 'u-alice', token.body.token.owner, 'u-alice', 'no trade side effects');
  run.check(scenario, 'control listing did not accidentally fail', controlList.status === 201, controlList.status, 201, 'normal collection remains tradeable');
}

async function scenarioStateMachine(run: AcceptanceRunner): Promise<void> {
  const scenario = 'order state machine boundaries';
  const list = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-cancel',
    sellerId: 'u-alice',
    price: 1234,
  });
  const orderId = list.body.order.id;

  const duplicate = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-cancel',
    sellerId: 'u-alice',
    price: 1234,
  });
  const nonCreator = await run.request('POST', '/orders/' + orderId + '/cancel', {
    requesterId: 'u-bob',
  });
  const filled = await run.request('POST', '/orders/' + orderId + '/accept', {
    buyerId: 'u-dave',
  });
  const cancelFilled = await run.request('POST', '/orders/' + orderId + '/cancel', {
    requesterId: 'u-alice',
  });

  run.check(scenario, 'initial listing is 201', list.status === 201, list.status, 201, 'owner and no active order');
  run.check(scenario, 'duplicate listing is conflict.duplicate_listing', duplicate.status === 409 && duplicate.body.error.reason === 'conflict.duplicate_listing', duplicate.body.error, { category: 'state', reason: 'conflict.duplicate_listing' }, 'one active order per token');
  run.check(scenario, 'non-creator cancel is conflict.not_order_creator', nonCreator.status === 409 && nonCreator.body.error.reason === 'conflict.not_order_creator', nonCreator.body.error, { category: 'state', reason: 'conflict.not_order_creator' }, 'only creator may cancel');
  run.check(scenario, 'creator accept succeeds', filled.status === 200, filled.status, 200, 'buyer has enough balance and seller holds token');
  run.check(scenario, 'filled cancel is conflict.order_already_filled', cancelFilled.status === 409 && cancelFilled.body.error.reason === 'conflict.order_already_filled', cancelFilled.body.error, { category: 'state', reason: 'conflict.order_already_filled' }, 'terminal filled state cannot cancel');

  const reasons = new Set([
    duplicate.body.error.reason,
    nonCreator.body.error.reason,
    cancelFilled.body.error.reason,
  ]);
  run.check(scenario, 'all 409 reasons are distinguishable', reasons.size === 3, [...reasons], ['conflict.duplicate_listing', 'conflict.not_order_creator', 'conflict.order_already_filled'], 'stable machine-readable reason codes');

  const cancelledList = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-non-creator',
    sellerId: 'u-alice',
    price: 10,
  });
  const cancelledId = cancelledList.body.order.id;
  const cancelByCreator = await run.request('POST', '/orders/' + cancelledId + '/cancel', {
    requesterId: 'u-alice',
  });
  const cancelAgain = await run.request('POST', '/orders/' + cancelledId + '/cancel', {
    requesterId: 'u-alice',
  });
  run.check(scenario, 'creator can cancel active order', cancelByCreator.status === 200 && cancelByCreator.body.transition.to === 'cancelled', cancelByCreator.body.transition, { from: 'active', to: 'cancelled' }, 'active to cancelled');
  run.check(scenario, 'cancel again is conflict.order_already_cancelled', cancelAgain.status === 409 && cancelAgain.body.error.reason === 'conflict.order_already_cancelled', cancelAgain.body.error, { reason: 'conflict.order_already_cancelled' }, 'terminal cancelled state');
}

async function scenarioSellerNotHolder(run: AcceptanceRunner): Promise<void> {
  const scenario = 'seller must still hold token';
  const list = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-move',
    sellerId: 'u-alice',
    price: 100,
  });
  const orderId = list.body.order.id;
  const before = users(await run.request('GET', '/users'));
  const moved = await run.request('POST', '/admin/tokens/col-art/tok-move/transfer', {
    from: 'u-alice',
    nextOwner: 'u-carol',
    reason: 'simulate token transfer after listing before accept',
  });
  const accept = await run.request('POST', '/orders/' + orderId + '/accept', { buyerId: 'u-bob' });
  const after = users(await run.request('GET', '/users'));
  const token = await run.request('GET', '/tokens/col-art/tok-move');

  run.check(scenario, 'deterministic local ownership move committed', moved.status === 200, moved.status, 200, 'fixture control operation');
  run.check(scenario, 'accept is conflict.seller_not_holder', accept.status === 409 && accept.body.error.reason === 'conflict.seller_not_holder', accept.body.error, { reason: 'conflict.seller_not_holder' }, 'holder checked at accept commit');
  run.check(scenario, 'current holder reported', accept.body.error.details.currentHolder === 'u-carol', accept.body.error.details.currentHolder, 'u-carol', 'diagnostic details retain intermediate state');
  run.check(scenario, 'no balances moved', total(before) === total(after), total(after), total(before), 'failed accept has no settlement side effects');
  run.check(scenario, 'token remains with carol', token.body.token.owner === 'u-carol', token.body.token.owner, 'u-carol', 'listing is invalid but token is not force-transferred');
}

async function scenarioInsufficientBalance(run: AcceptanceRunner): Promise<void> {
  const scenario = 'insufficient balance';
  const list = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-poor-buyer',
    sellerId: 'u-alice',
    price: 100,
  });
  const accept = await run.request('POST', '/orders/' + list.body.order.id + '/accept', {
    buyerId: 'u-broke',
  });
  run.check(scenario, 'accept is conflict.insufficient_balance', accept.status === 409 && accept.body.error.reason === 'conflict.insufficient_balance', accept.body.error, { category: 'state', reason: 'conflict.insufficient_balance' }, 'balance checked in transaction');
  run.check(scenario, 'balance and required amount reported', accept.body.error.details.balance === 5 && accept.body.error.details.required === 100, accept.body.error.details, { balance: 5, required: 100 }, 'replayable diagnostic details');
}

async function scenarioInputErrors(run: AcceptanceRunner): Promise<void> {
  const scenario = 'input validation';
  const cases: Array<{ name: string; url: string; payload: unknown; reason: string }> = [
    {
      name: 'price zero',
      url: '/orders/listings',
      payload: { collectionId: 'col-art', tokenId: 'tok-zero', sellerId: 'u-bob', price: 0 },
      reason: 'input.price_not_positive_integer',
    },
    {
      name: 'price fractional',
      url: '/orders/listings',
      payload: { collectionId: 'col-art', tokenId: 'tok-zero', sellerId: 'u-bob', price: 1.25 },
      reason: 'input.price_not_positive_integer',
    },
    {
      name: 'unknown collection',
      url: '/orders/listings',
      payload: { collectionId: 'col-missing', tokenId: 'tok-x', sellerId: 'u-bob', price: 1 },
      reason: 'input.unknown_collection',
    },
    {
      name: 'unknown token',
      url: '/orders/listings',
      payload: { collectionId: 'col-art', tokenId: 'tok-missing', sellerId: 'u-bob', price: 1 },
      reason: 'input.unknown_token',
    },
    {
      name: 'bps too large',
      url: '/admin/collections/col-art/royalty',
      payload: { royaltyBps: 10001 },
      reason: 'input.bps_out_of_range',
    },
    {
      name: 'unknown order',
      url: '/orders/ord-missing/cancel',
      payload: { requesterId: 'u-alice' },
      reason: 'input.unknown_order',
    },
  ];

  for (const item of cases) {
    const reply = await run.request('POST', item.url, item.payload);
    run.check(scenario, item.name + ' is 422 ' + item.reason, reply.status === 422 && reply.body.error.reason === item.reason, reply.body.error, { category: 'input', reason: item.reason }, 'contract parser rejects before state mutation');
  }

  const malformed = await run.app.app.inject({
    method: 'POST',
    url: '/orders/listings',
    headers: { 'content-type': 'application/json' },
    payload: '{ bad json',
  });
  const malformedBody = malformed.json();
  console.log('REQUEST POST /orders/listings with malformed JSON');
  console.log('RESPONSE ' + String(malformed.statusCode));
  console.log(JSON.stringify(malformedBody, null, 2));
  run.check(
    scenario,
    'malformed JSON is 422 input.bad_type',
    malformed.statusCode === 422 && malformedBody.error.reason === 'input.bad_type',
    malformedBody.error,
    { category: 'input', reason: 'input.bad_type' },
    'HTTP parser failures use the same input contract',
  );
}

async function scenarioFailureClasses(run: AcceptanceRunner, main: BuiltApp): Promise<void> {
  const scenario = 'resource and computation failure classes';

  const disable = await run.request('POST', '/admin/faults/storage-unavailable', { unavailable: true });
  const unavailable = await run.request('POST', '/orders/listings', {
    collectionId: 'col-art',
    tokenId: 'tok-conservation',
    sellerId: 'u-alice',
    price: 1,
  });
  const restore = await run.request('POST', '/admin/faults/storage-unavailable', { unavailable: false });
  run.check(scenario, 'storage can be marked unavailable locally', disable.status === 200, disable.status, 200, 'synthetic fault switch');
  run.check(scenario, 'unavailable storage is 503 resource.storage_unavailable', unavailable.status === 503 && unavailable.body.error.reason === 'resource.storage_unavailable', unavailable.body.error, { category: 'resource', reason: 'resource.storage_unavailable' }, 'resource exhaustion never returned as success');
  run.check(scenario, 'storage restored', restore.status === 200, restore.status, 200, 'fault switch restored');

  const conservation = await run.request('POST', '/admin/faults/conservation-failure', {});
  run.check(scenario, 'conservation assertion is 500 computation.conservation_violation', conservation.status === 500 && conservation.body.error.reason === 'computation.conservation_violation', conservation.body.error, { category: 'computation', reason: 'computation.conservation_violation' }, 'calculation failure has independent category');

  const dbDir = join(process.cwd(), '.tmp-acceptance-locks');
  const dbPath = join(dbDir, 'accept-lock.db');
  rmSync(dbPath, { force: true });
  const lockedApp = await makeApp({ dbPath, lockWaitMs: 30, diagConsole: false });
  const releaseLock = lockedApp.ledger.holdExternalWriteLock();
  const response = await lockedApp.app.inject({
    method: 'POST',
    url: '/orders/listings',
    payload: {
      collectionId: 'col-art',
      tokenId: 'tok-conservation',
      sellerId: 'u-alice',
      price: 1,
    },
  });
  const lockedBody = response.json();
  releaseLock();
  await lockedApp.close();
  console.log('\n=== LOCK TIMEOUT PROBE ===');
  console.log('REQUEST POST /orders/listings while a second SQLite connection holds BEGIN IMMEDIATE');
  console.log('RESPONSE ' + String(response.statusCode));
  console.log(JSON.stringify(lockedBody, null, 2));
  run.check(scenario, 'SQLite lock wait is 503 resource.lock_timeout', response.statusCode === 503 && lockedBody.error.reason === 'resource.lock_timeout', lockedBody.error, { category: 'resource', reason: 'resource.lock_timeout' }, 'real local SQLite BUSY/LOCKED condition');
}

async function main(): Promise<void> {
  console.log('NFT fixed-price market acceptance suite');
  console.log('Fixed seed: local synthetic users, collections, token ownership, balances');
  const diagLogPath = join(process.cwd(), 'artifacts', 'acceptance', 'diag.jsonl');

  rmSync(diagLogPath, { force: true });
  const app = await makeApp({ dbPath: ':memory:', lockWaitMs: 250, diagConsole: false, diagLogPath });
  const run = new AcceptanceRunner(app);

  try {
    await scenarioRoyalty(run);
    await scenarioConcurrent(run);
    await scenarioSoulbound(run);
    await scenarioStateMachine(run);
    await scenarioSellerNotHolder(run);
    await scenarioInsufficientBalance(run);
    await scenarioInputErrors(run);
    await scenarioFailureClasses(run, app);

    const diag = await app.app.inject({ method: 'GET', url: '/diag/runs' });
    const runs = diag.json().runs;
    console.log('\n=== DIAGNOSTIC SUMMARY ===');
    console.log('terminal runs recorded: ' + String(runs.length));
    for (const event of runs) {
      console.log(
        event.runId +
        ' ' + event.action +
        ' ' + event.decision +
        ' http=' + String(event.httpStatus) +
        ' reason=' + String(event.reason) +
        ' order=' + String(event.orderId ?? '-') +
        ' transition=' + (event.transition ? event.transition.from + '->' + event.transition.to : '-') +
        ' split=' + (event.settlement ? String(event.settlement.royaltyAmount) + '+' + String(event.settlement.sellerProceeds) + '=' + String(event.settlement.grossPrice) : '-'),
      );
    }

    if (run.failures.length > 0) {
      console.log('\nACCEPTANCE FAILED: ' + String(run.failures.length) + ' scenario assertion(s) failed');
      for (const failure of run.failures) console.log('FAILED SCENARIO: ' + failure);
      process.exitCode = 1;
    } else {
      console.log('\nACCEPTANCE PASSED: all scenarios passed');
      process.exitCode = 0;
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('ACCEPTANCE ERRORED');
  console.error(error);
  process.exit(1);
});
