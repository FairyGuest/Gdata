import { buildServer, listen } from '../src/api/server.ts';
import { Store } from '../src/state/store.ts';
import { loadConfig } from '../src/config.ts';

const config = { ...loadConfig(), port: 0, dbPath: ':memory:' };
const server = buildServer(new Store(':memory:'), config);
const port = await listen(server, 0);
const base = 'http://127.0.0.1:' + port;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

console.log('== register rules ==');
console.log(JSON.stringify(await call('PUT', '/rules', { rules: [
  { name: 'no-eval', enabled: true, severity: 'error', message: 'eval() is forbidden', match: { kind: 'regex', pattern: 'eval\\(' } },
  { name: 'no-console', enabled: true, severity: 'warning', message: 'avoid console.log', match: { kind: 'regex', pattern: 'console\\.log' } },
  { name: 'fn-name-style', enabled: true, severity: 'info', message: 'function name should not start with _', match: { kind: 'ast', nodeType: 'FunctionDeclaration', pattern: '^_' } },
] }), null, 1));

const source = [
  'import x from "x";',
  'function _helper() {',
  '  eval("1+1");',
  '  console.log("done");',
  '}',
].join('\n');

console.log('== check #1 ==');
const run1 = (await call('POST', '/check', { file: 'src/demo.ts', source })).json as { runId: string; violations: unknown[] };
console.log(JSON.stringify(run1, null, 1));

console.log('== check #2 (eval removed, new console.log added) ==');
const source2 = source.replace('  eval("1+1");\n', '').replace('}', '  console.log("again");\n}');
const run2 = (await call('POST', '/check', { file: 'src/demo.ts', source: source2 })).json as { runId: string };
console.log(JSON.stringify(run2, null, 1));

console.log('== diff run1 -> run2 ==');
console.log(JSON.stringify(await call('GET', '/diff?from=' + run1.runId + '&to=' + run2.runId), null, 1));

server.close();

