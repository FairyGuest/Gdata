import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, parseEvent, canonicalEvent } from '../src/contract/events.ts';

const mint = { seq: 1, type: 'mint', tokenId: 't1', from: null, to: '0x' + 'a'.repeat(40), price: null };

test('parses a well-formed mint event', () => {
  const ev = parseEvent(mint);
  assert.equal(ev.seq, 1);
  assert.equal(ev.type, 'mint');
  assert.equal(ev.from, null);
});

test('rejects non-integer / zero / negative seq with 422 invalid_input', () => {
  for (const seq of [0, -1, 1.5, '3', undefined]) {
    assert.throws(() => parseEvent({ ...mint, seq }), (err: unknown) => {
      const e = err as ContractError;
      assert.ok(e instanceof ContractError);
      assert.equal(e.status, 422);
      assert.equal(e.reason, 'invalid_input');
      return true;
    });
  }
});

test('rejects unknown event type', () => {
  assert.throws(() => parseEvent({ ...mint, type: 'burn' }), ContractError);
});

test('transfer requires from, sale requires price, mint forbids both', () => {
  const base = { ...mint, seq: 2 };
  assert.throws(() => parseEvent({ ...base, type: 'transfer', from: null }), ContractError);
  assert.throws(() => parseEvent({ ...base, type: 'sale', from: '0x' + 'b'.repeat(40), price: null }), ContractError);
  assert.throws(() => parseEvent({ ...base, type: 'mint', from: '0x' + 'b'.repeat(40) }), ContractError);
  assert.throws(() => parseEvent({ ...base, type: 'mint', price: 5 }), ContractError);
});

test('rejects malformed addresses and negative price', () => {
  assert.throws(() => parseEvent({ ...mint, to: 'not-an-address' }), ContractError);
  assert.throws(
    () => parseEvent({ ...mint, seq: 2, type: 'sale', from: '0x' + 'b'.repeat(40), price: -3 }),
    ContractError,
  );
});

test('canonicalEvent distinguishes content changes on the same seq', () => {
  const a = parseEvent(mint);
  const b = parseEvent({ ...mint, to: '0x' + 'c'.repeat(40) });
  assert.notEqual(canonicalEvent(a), canonicalEvent(b));
  assert.equal(canonicalEvent(a), canonicalEvent(parseEvent(mint)));
});
