const { test } = require('../../dist/framework.js');
const assert = require('node:assert');

test('加法正确', () => {
  assert.strictEqual(1 + 1, 2);
});

test('异步用例也能通过', async () => {
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(true);
});