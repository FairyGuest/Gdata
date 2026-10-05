import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../src/notify.js';
import { sent } from '../src/channel.js';

test('notify sends the message and returns true', () => {
  const before = sent.length;
  const result = notify('hello');
  assert.equal(result, true);
  assert.equal(sent.length, before + 1);
  assert.equal(sent[sent.length - 1], 'hello');
});

