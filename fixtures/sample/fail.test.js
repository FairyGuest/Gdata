const { test } = require('../../dist/framework.js');
const assert = require('node:assert');

test('断言失败用例', () => {
  assert.strictEqual(2 + 2, 5, '数学没有崩坏');
});

test('运行时异常用例', () => {
  throw new TypeError('boom: 未捕获的运行时异常');
});

test('同文件内其他用例不受影响', () => {
  assert.strictEqual('abc'.length, 3);
});