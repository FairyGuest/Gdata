const { test } = require('../../dist/framework.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const marker = path.join(os.tmpdir(), 'runner-parallel-b.marker');

test('并行用例B：写自己的标记文件并睡眠400ms', async () => {
  fs.writeFileSync(marker, 'B');
  await new Promise((r) => setTimeout(r, 400));
  if (fs.readFileSync(marker, 'utf8') !== 'B') throw new Error('标记文件被干扰');
  fs.unlinkSync(marker);
});