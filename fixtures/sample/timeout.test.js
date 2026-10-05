const { test } = require('../../dist/framework.js');

test('永不结束的用例', () => {
  // 死循环 + 定时器，既不返回也不退出事件循环
  setInterval(() => {}, 1000);
  while (true) {}
});

test('快速通过的邻居用例', async () => {
  await new Promise((r) => setTimeout(r, 20));
});