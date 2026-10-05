// 本地演示：启动服务并打一遍代表性请求。
import { buildServer } from '../dist/server.js';
import { loadRouteConfigFile } from '../dist/config/loader.js';

const PORT = 3000;
const rules = loadRouteConfigFile('config/routes.demo.json');
const { app } = buildServer({ rules });
await app.listen({ port: PORT, host: '127.0.0.1' });
const base = `http://127.0.0.1:${PORT}`;

const show = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log(`${method} ${path} -> ${res.status}`, await res.text());
};

await show('GET', '/api/users/42');
await show('GET', '/api/files/deep/nested/file.txt');
await show('GET', '/api/seq');
await show('GET', '/api/seq');
await show('GET', '/api/seq');
await show('POST', '/api/orders', { type: 'vip', item: 'book' });
await show('POST', '/api/orders', { type: 'normal' });
await show('GET', '/api/slow');
await show('GET', '/__mock/requests');
await show('POST', '/__mock/reset');
await app.close();
console.log('demo done');
