import { buildServer, listen } from '../src/api/server.ts';
import { Store } from '../src/state/store.ts';
import type { Server } from 'node:http';

let failures = 0;
let stepNo = 0;

function judge(name: string, ok: boolean, reason: string): void {
  stepNo += 1;
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log('[' + tag + '] step ' + stepNo + ': ' + name + ' -- ' + reason);
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  console.log('  >> ' + method + ' ' + path + (body !== undefined ? ' body=' + JSON.stringify(body) : ''));
  console.log('  << ' + res.status + ' ' + JSON.stringify(json));
  return { status: res.status, json: json as Record<string, unknown> };
}

const config = { port: 0, dbPath: ':memory:', limits: { maxSourceBytes: 1024, maxRules: 10, maxMatchesPerRule: 100 } };
const server: Server = buildServer(new Store(':memory:'), config);
const port = await listen(server, 0);
const base = 'http://127.0.0.1:' + port;
console.log('accept: server on ' + base + ' (in-memory sqlite, maxSourceBytes=1024)');

// Scenario 0: register the rule set used by all following scenarios
let r = await call(base, 'PUT', '/rules', { rules: [
  { name: 'no-eval', enabled: true, severity: 'error', message: 'eval() is forbidden', match: { kind: 'regex', pattern: 'eval\\(' } },
  { name: 'no-eval-loose', enabled: true, severity: 'warning', message: 'eval usage (loose)', match: { kind: 'regex', pattern: 'eval' } },
  { name: 'no-console', enabled: true, severity: 'warning', message: 'avoid console.log', match: { kind: 'regex', pattern: 'console\\.log' } },
  { name: 'no-todo', enabled: true, severity: 'info', message: 'TODO marker', match: { kind: 'regex', pattern: 'TODO' } },
  { name: 'fn-underscore', enabled: true, severity: 'warning', message: 'function name starts with _', match: { kind: 'ast', nodeType: 'FunctionDeclaration', pattern: '^_' } },
  { name: 'no-lodash-import', enabled: true, severity: 'error', message: 'do not import lodash', match: { kind: 'ast', nodeType: 'ImportStatement', pattern: 'lodash' } },
] });
judge('register rules', r.status === 200 && (r.json as { count: number }).count === 6, 'PUT /rules -> 200, count=6');

// Scenario 1: regex rule hits specified pattern
r = await call(base, 'POST', '/check', { file: 's1.ts', source: 'const x = 1;\nconsole.log("hi");\n' });
let v = (r.json as { violations: Array<Record<string, unknown>> }).violations;
judge('regex rule hit', r.status === 200 && v.length === 1 && v[0].rule === 'no-console' && v[0].line === 2 && v[0].column === 1, 'one no-console violation at 2:1');
const runS1 = (r.json as { runId: string }).runId;

// Scenario 2: AST node type matching
r = await call(base, 'POST', '/check', { file: 's2.ts', source: 'import _ from "lodash";\nfunction _hidden() {}\nfunction visible() {}\n' });
v = (r.json as { violations: Array<Record<string, unknown>> }).violations;
const astOk = v.length === 2
  && v.some((x) => x.rule === 'no-lodash-import' && x.line === 1)
  && v.some((x) => x.rule === 'fn-underscore' && x.line === 2);
judge('ast node type match', r.status === 200 && astOk, 'lodash import at line 1, _hidden function at line 2, visible() not flagged');

// Scenario 3: multiple rules at same position sorted by severity desc
r = await call(base, 'POST', '/check', { file: 's3.ts', source: 'eval("x");\n' });
v = (r.json as { violations: Array<Record<string, unknown>> }).violations;
const orderOk = v.length === 2
  && v[0].rule === 'no-eval' && v[0].severity === 'error'
  && v[1].rule === 'no-eval-loose' && v[1].severity === 'warning'
  && v[0].line === 1 && v[0].column === 1 && v[1].line === 1 && v[1].column === 1;
judge('same-position severity ordering', r.status === 200 && orderOk, 'at 1:1 no-eval(error) ranks before no-eval-loose(warning)');

// Scenario 4: diff between two checks (added / removed)
const before = 'eval("1");\nconsole.log("a");\n';
const after = 'console.log("a");\nconsole.log("b");\n';
r = await call(base, 'POST', '/check', { file: 's4.ts', source: before });
const runA = (r.json as { runId: string }).runId;
r = await call(base, 'POST', '/check', { file: 's4.ts', source: after });
const runB = (r.json as { runId: string }).runId;
r = await call(base, 'GET', '/diff?from=' + runA + '&to=' + runB);
const diff = r.json as { added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>> };
const removedRules = diff.removed.map((x) => x.rule).sort();
const diffOk = diff.added.length === 1 && diff.added[0].rule === 'no-console' && diff.added[0].line === 1
  && diff.removed.length === 2 && removedRules.join(',') === 'no-eval,no-eval-loose';
judge('diff added/removed', r.status === 200 && diffOk, 'removed: no-eval+no-eval-loose @1:1; added: no-console@1:1 (console.log shifted up one line)');

// Scenario 5: enable/disable
r = await call(base, 'PATCH', '/rules/no-console', { enabled: false });
const patchOk = r.status === 200;
r = await call(base, 'POST', '/check', { file: 's5.ts', source: 'console.log("x");\n' });
v = (r.json as { violations: unknown[] }).violations;
judge('rule disable takes effect', patchOk && v.length === 0, 'no-console disabled -> 0 violations');

// Scenario 6: error categories are distinguishable
r = await call(base, 'PUT', '/rules', { rules: [{ name: 'bad', enabled: true, severity: 'error', message: 'm', match: { kind: 'regex', pattern: '([' } }] });
judge('input error -> 400 INPUT_ERROR', r.status === 400 && (r.json as { error: { category: string } }).error.category === 'INPUT_ERROR', 'invalid regex rejected');

r = await call(base, 'POST', '/rules', { rule: { name: 'no-eval', enabled: true, severity: 'info', message: 'm', match: { kind: 'regex', pattern: 'z' } } });
judge('state conflict -> 409 STATE_CONFLICT', r.status === 409 && (r.json as { error: { category: string } }).error.category === 'STATE_CONFLICT', 'duplicate rule name rejected');

r = await call(base, 'GET', '/runs/run-missing');
judge('missing run -> 404 NOT_FOUND', r.status === 404 && (r.json as { error: { category: string } }).error.category === 'NOT_FOUND', 'unknown run id');

r = await call(base, 'POST', '/check', { file: 'big.ts', source: 'x'.repeat(5000) });
judge('resource exhausted -> 413 RESOURCE_EXHAUSTED', r.status === 413 && (r.json as { error: { category: string } }).error.category === 'RESOURCE_EXHAUSTED', 'source over 1024-byte limit');

// Scenario 7: run log is persisted and replayable
r = await call(base, 'GET', '/runs/' + runS1);
const log = (r.json as { log: Array<{ step: string }> }).log;
judge('run log persisted', r.status === 200 && Array.isArray(log) && log.some((e) => e.step === 'rule') && log.some((e) => e.step === 'done'), 'GET /runs/' + runS1 + ' returns engine log with rule/done steps');

console.log(failures === 0 ? 'ACCEPT RESULT: all ' + stepNo + ' steps passed' : 'ACCEPT RESULT: ' + failures + ' of ' + stepNo + ' steps FAILED');
process.exitCode = failures === 0 ? 0 : 1;
server.close();

