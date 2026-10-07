/** Local demo: spins up the service, registers fixture targets, replays events. */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BuildService } from '../src/service/buildService.ts';
import { buildApp } from '../src/http/app.ts';

const root = mkdtempSync(join(tmpdir(), 'bw-demo-'));
const write = (rel: string, content: string) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};
write('src/lib.ts', 'export const lib = 1;');
write('src/app.ts', 'import { lib } from "./lib";');
write('docs/readme.md', '# docs');

const config = loadConfig({ dbPath: join(root, 'demo.db'), workspaceRoot: root, port: 8787 });
const service = new BuildService(config);
const app = buildApp(service);
await app.listen({ port: config.port, host: config.host });
console.log(`demo service on http://${config.host}:${config.port}, workspace ${root}`);

const base = `http://${config.host}:${config.port}`;
const post = async (p: string, b: unknown) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();

console.log(await post('/targets', { targets: [
  { name: 'lib', paths: ['src/lib.ts'], deps: [] },
  { name: 'app', paths: ['src/app.ts'], deps: ['lib'] },
  { name: 'docs', paths: ['docs/readme.md'], deps: [] },
] }));
const ev = await post('/events', { paths: ['src/lib.ts'] });
console.log('submitted run', ev);
await service.waitForIdle();
console.log('run result:', JSON.stringify(await (await fetch(`${base}/runs/${ev.runId}`)).json(), null, 2));
console.log('state:', JSON.stringify(await (await fetch(`${base}/state`)).json(), null, 2));

await app.close();
service.close();