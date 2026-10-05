// 本地演示：启动内存版服务器，依次演示通配符、序号响应、延迟与请求记录。
import { MockEngine } from '../src/core/engine.ts';
import { RequestRecorder } from '../src/state/recorder.ts';
import { loadRoutesFromFile } from '../src/config/loader.ts';
import { startMockServer } from '../src/adapters/http.ts';

const routes = loadRoutesFromFile('config/routes.demo.json');
const engine = new MockEngine(routes);
const recorder = new RequestRecorder();
const { port, close } = await startMockServer({ engine, recorder, port: 0 });
const base = `http://127.0.0.1:${port}`;
console.log(`演示服务器: ${base}`);

console.log('\n--- 1. 通配符路由 /api/users/* 按序号返回不同响应 ---');
for (let i = 1; i <= 3; i++) {
  const res = await fetch(`${base}/api/users/1`);
  console.log(`第 ${i} 次: ${res.status} x-mock=${res.headers.get('x-mock')}`, await res.text());
}

console.log('\n--- 2. 延迟响应 /api/reports/2024（delayMs=300） ---');
const t0 = performance.now();
const slow = await fetch(`${base}/api/reports/2024`);
console.log(`状态 ${slow.status}，耗时 ${(performance.now() - t0).toFixed(0)}ms`, await res_text(slow));
async function res_text(r: Response) { return await r.text(); }

console.log('\n--- 3. 请求体匹配 POST /api/orders ---');
const order = await fetch(`${base}/api/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sku: 'A-1', qty: 5 }),
});
console.log(`命中: ${order.status}`, await order.text());

console.log('\n--- 4. 请求记录（调用顺序） ---');
const records = await (await fetch(`${base}/__requests`)).json();
for (const r of records.requests) {
  console.log(`#${r.seq} ${r.method} ${r.path} -> route=${r.routeId ?? '(未命中)'}`);
}

await close();
recorder.close();
