import type { InjectOptions } from 'fastify';
/**
 * One-shot acceptance drill: exercises every specified scenario in a fixed
 * order against a freshly seeded in-memory service, printing each request,
 * response and verdict. Exit code 0 iff every scenario passes.
 */
import { parseCollectionConfig } from '../src/contract/parse.ts';
import { Journal } from '../src/diag/journal.ts';
import { bootstrapLedger } from '../src/fixtures/seed.ts';
import { buildApp } from '../src/http/app.ts';
import { MarketEngine } from '../src/kernel/engine.ts';
import { Ledger } from '../src/state/ledger.ts';

const SEED = 1337;
const ledger = new Ledger(':memory:');
const { runId, manifest } = bootstrapLedger(ledger, SEED);
const journal = new Journal(ledger, runId);
const engine = new MarketEngine(ledger, journal);
const app = buildApp({ ledger, engine, journal, runId });

let failures = 0;
let stepNo = 0;

function balance(id: string): number {
  const b = ledger.getBalance(id);
  if (b === undefined) throw new Error('no user ' + id);
  return b;
}
function seeded(id: string): number {
  const u = manifest.users.find((x) => x.id === id);
  if (!u) throw new Error('no fixture user ' + id);
  return u.balance;
}

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    console.log('    PASS  ' + label);
  } else {
    failures += 1;
    console.log('    FAIL  ' + label + (extra === undefined ? '' : '  ::  ' + JSON.stringify(extra)));
  }
}

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<ApiResult> {
  const opts: InjectOptions = { method, url };
  if (payload !== undefined) opts.payload = payload as Record<string, unknown>;
  const res = await app.inject(opts);
  console.log('    >> ' + method + ' ' + url + (payload === undefined ? '' : '  ' + JSON.stringify(payload)));
  console.log('    << ' + String(res.statusCode) + '  ' + res.body);
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

function errOf(r: ApiResult): { category: string; reason: string } {
  return (r.body as { error: { category: string; reason: string } }).error;
}

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  stepNo += 1;
  console.log('STEP ' + String(stepNo).padStart(2, '0') + '  ' + name);
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log('    FAIL  scenario threw: ' + String(err));
  }
}

console.log('=== nft-marketplace acceptance drill (runId=' + runId + ', seed=' + String(SEED) + ') ===');

let orderA = '';
let orderB = '';
let orderC = '';
let orderD = '';

await step('ledger seeded and conserved at boot', async () => {
  const r = await call('GET', '/diag/health');
  check(r.status === 200, 'health endpoint 200');
  check((r.body as { conserved: boolean }).conserved === true, 'balance sum conserved', r.body);
  check((r.body as { actualBalanceSum: number }).actualBalanceSum === manifest.expectedBalanceSum, 'sum matches fixture manifest');
});

await step('list art-1 by alice @1003 (col-art, 250 bps)', async () => {
  const r = await call('POST', '/orders', { tokenId: 'art-1', sellerId: 'alice', price: 1003 });
  check(r.status === 201, 'created 201');
  const order = (r.body as { order: { id: string; royaltyBps: number; status: string } }).order;
  orderA = order.id;
  check(order.status === 'open', 'order open');
  check(order.royaltyBps === 250, 'royalty snapshot 250 bps');
});

await step('duplicate listing on art-1 -> 409 duplicate_listing', async () => {
  const r = await call('POST', '/orders', { tokenId: 'art-1', sellerId: 'alice', price: 5 });
  check(r.status === 409, 'status 409');
  check(errOf(r).category === 'state' && errOf(r).reason === 'duplicate_listing', 'state/duplicate_listing', errOf(r));
});

await step('cancel by non-creator -> 409 not_order_creator', async () => {
  const r = await call('POST', '/orders/' + orderA + '/cancel', { actorId: 'bob' });
  check(r.status === 409, 'status 409');
  check(errOf(r).reason === 'not_order_creator', 'reason not_order_creator', errOf(r));
});

await step('accept by bob: royalty 25 / seller 978 / buyer pays 1003', async () => {
  const r = await call('POST', '/orders/' + orderA + '/accept', { buyerId: 'bob' });
  check(r.status === 200, 'status 200');
  const fill = (r.body as { fill: { royalty: number; sellerProceeds: number; price: number; newOwner: string; commitSeq: number } }).fill;
  check(fill.royalty === 25, 'royalty == 25 (floor(1003*250/10000))', fill);
  check(fill.sellerProceeds === 978, 'sellerProceeds == 978', fill);
  check(fill.price === 1003 && fill.royalty + fill.sellerProceeds === fill.price, 'split sums to price');
  check(fill.newOwner === 'bob', 'new owner bob');
  check(balance('bob') === seeded('bob') - 1003, 'bob debited exactly 1003');
  check(balance('alice') === seeded('alice') + 978, 'alice credited 978');
  check(balance('acct-royalty-art') === 25, 'royalty account credited 25');
  check(ledger.getToken('art-1')?.ownerId === 'bob', 'token owner is bob in ledger');
  const persisted = ledger.getFill(orderA);
  check(persisted?.royalty === 25 && persisted.sellerProceeds === 978 && persisted.commitSeq === fill.commitSeq, 'response matches commit snapshot');
});

await step('cancel filled order -> 409 order_not_open', async () => {
  const r = await call('POST', '/orders/' + orderA + '/cancel', { actorId: 'alice' });
  check(r.status === 409, 'status 409');
  check(errOf(r).reason === 'order_not_open', 'reason order_not_open', errOf(r));
});

await step('royalty snapshot: collection edit after listing does not apply', async () => {
  const created = await call('POST', '/orders', { tokenId: 'art-2', sellerId: 'alice', price: 2000 });
  orderB = (created.body as { order: { id: string } }).order.id;
  ledger.db.exec("UPDATE collections SET royalty_bps = 9000, royalty_recipient = 'acct-royalty-zero' WHERE id = 'col-art'");
  console.log('    .. collection col-art mutated to 9000 bps after listing');
  const r = await call('POST', '/orders/' + orderB + '/accept', { buyerId: 'carol' });
  const fill = (r.body as { fill: { royalty: number; sellerProceeds: number; royaltyRecipient: string } }).fill;
  check(fill.royalty === 50, 'royalty still snapshot 50 (250bps of 2000)', fill);
  check(fill.sellerProceeds === 1950, 'seller proceeds 1950');
  check(fill.royaltyRecipient === 'acct-royalty-art', 'recipient from snapshot');
  check(balance('acct-royalty-zero') === 0, 'new recipient got nothing');
});

await step('concurrent double accept: exactly one 200, one 409, single transfer', async () => {
  const created = await call('POST', '/orders', { tokenId: 'zero-1', sellerId: 'alice', price: 100 });
  orderC = (created.body as { order: { id: string } }).order.id;
  const [r1, r2] = await Promise.all([
    app.inject({ method: 'POST', url: '/orders/' + orderC + '/accept', payload: { buyerId: 'bob' } }),
    app.inject({ method: 'POST', url: '/orders/' + orderC + '/accept', payload: { buyerId: 'carol' } }),
  ]);
  console.log('    << race results: ' + String(r1.statusCode) + ' / ' + String(r2.statusCode));
  const statuses = [r1.statusCode, r2.statusCode].sort();
  check(statuses[0] === 200 && statuses[1] === 409, 'exactly one 200 and one 409', statuses);
  const loser = r1.statusCode === 409 ? r1 : r2;
  check(errOf({ status: 0, body: loser.json() as Record<string, unknown> }).reason === 'order_not_open', 'loser reason order_not_open');
  check(ledger.countFills() === 3, 'exactly 3 fills total so far (one for this order)');
  check(ledger.sumBalances() === manifest.expectedBalanceSum, 'ledger conserved after race');
  const winnerId = ((r1.statusCode === 200 ? r1 : r2).json() as { fill: { buyerId: string } }).fill.buyerId;
  check(ledger.getToken('zero-1')?.ownerId === winnerId, 'ownership transferred once to winner ' + winnerId);
});

await step('soulbound: listing rejected with policy category', async () => {
  const r = await call('POST', '/orders', { tokenId: 'soul-1', sellerId: 'alice', price: 100 });
  check(r.status === 409, 'status 409');
  check(errOf(r).category === 'policy' && errOf(r).reason === 'soulbound_transfer', 'policy/soulbound_transfer', errOf(r));
});

await step('soulbound: accept rejected after collection flagged', async () => {
  const created = await call('POST', '/orders', { tokenId: 'art-3', sellerId: 'bob', price: 100 });
  orderD = (created.body as { order: { id: string } }).order.id;
  ledger.db.exec("UPDATE collections SET soulbound = 1 WHERE id = 'col-art'");
  console.log('    .. collection col-art flagged soulbound after listing');
  const r = await call('POST', '/orders/' + orderD + '/accept', { buyerId: 'carol' });
  check(r.status === 409, 'status 409');
  check(errOf(r).category === 'policy' && errOf(r).reason === 'soulbound_transfer', 'policy/soulbound_transfer', errOf(r));
  check(ledger.getToken('art-3')?.ownerId === 'bob', 'no transfer happened');
  ledger.db.exec("UPDATE collections SET soulbound = 0 WHERE id = 'col-art'");
  const cancel = await call('POST', '/orders/' + orderD + '/cancel', { actorId: 'bob' });
  check(cancel.status === 200, 'cleanup: creator can still cancel');
});

await step('input errors -> 422 (price, token, collection, bps)', async () => {
  const badPrice = await call('POST', '/orders', { tokenId: 'art-4', sellerId: 'carol', price: -1 });
  check(badPrice.status === 422 && errOf(badPrice).reason === 'invalid_price', 'negative price 422 invalid_price');
  const badToken = await call('POST', '/orders', { tokenId: 'ghost', sellerId: 'carol', price: 1 });
  check(badToken.status === 422 && errOf(badToken).reason === 'unknown_token', 'unknown token 422');
  const badCol = await call('GET', '/collections/ghost');
  check(badCol.status === 422 && errOf(badCol).reason === 'unknown_collection', 'unknown collection 422');
  let bpsRejected = false;
  try {
    parseCollectionConfig({ id: 'x', name: 'x', royaltyBps: 10001, royaltyRecipient: 'r', soulbound: false });
  } catch (err) {
    bpsRejected = (err as { reason?: string }).reason === 'invalid_bps';
  }
  check(bpsRejected, 'bps 10001 rejected by contract layer (invalid_bps)');
});

await step('insufficient balance -> 409 insufficient_balance', async () => {
  const created = await call('POST', '/orders', { tokenId: 'art-4', sellerId: 'carol', price: 100 });
  const oid = (created.body as { order: { id: string } }).order.id;
  const r = await call('POST', '/orders/' + oid + '/accept', { buyerId: 'dave' });
  check(r.status === 409 && errOf(r).reason === 'insufficient_balance', 'dave (balance ' + String(seeded('dave')) + ') cannot pay 100', errOf(r));
  check(balance('dave') === seeded('dave'), 'dave not charged');
  await call('POST', '/orders/' + oid + '/cancel', { actorId: 'carol' });
});

await step('seller no longer holds token -> 409 seller_not_owner, order lapses', async () => {
  const created = await call('POST', '/orders', { tokenId: 'art-4', sellerId: 'carol', price: 100 });
  const oid = (created.body as { order: { id: string } }).order.id;
  ledger.db.exec("UPDATE tokens SET owner_id = 'alice' WHERE id = 'art-4'");
  console.log('    .. art-4 transferred out-of-band to alice');
  const r = await call('POST', '/orders/' + oid + '/accept', { buyerId: 'bob' });
  check(r.status === 409 && errOf(r).reason === 'seller_not_owner', 'seller_not_owner', errOf(r));
  check(ledger.getOrder(oid)?.status === 'cancelled', 'order lapsed to cancelled');
});

await step('final conservation + diag journal', async () => {
  const r = await call('GET', '/diag/health');
  check((r.body as { conserved: boolean }).conserved === true, 'ledger conserved at end of drill');
  const events = journal.allEvents();
  check(events.length > 0, 'diag journal recorded ' + String(events.length) + ' events');
  const fillEvents = events.filter((e) => e.transition === 'open->filled');
  check(fillEvents.length === 3, '3 fill events with split detail logged');
  const sample = await call('GET', '/diag/fills/' + orderA);
  check(sample.status === 200, 'fill detail retrievable for replay (runId=' + runId + ')');
});

console.log('');
if (failures === 0) {
  console.log('=== ACCEPTANCE PASSED: all ' + String(stepNo) + ' scenarios green ===');
  process.exit(0);
} else {
  console.log('=== ACCEPTANCE FAILED: ' + String(failures) + ' check(s) failed across ' + String(stepNo) + ' scenarios ===');
  process.exit(1);
}
