const { test } = require('../../dist/framework.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const marker = path.join(os.tmpdir(), 'runner-parallel-a.marker');

test('并行用例A：写自己的标记文件并睡眠400ms', async () => {
  fs.writeFileSync(marker, 'A');
  await new Promise((r) => setTimeout(r, 400));
  // 睡眠期间标记文件不应被别人篡改
  if (fs.readFileSync(marker, 'utf8') !== 'A') throw new Error('标记文件被干扰');
  fs.unlinkSync(marker);
});