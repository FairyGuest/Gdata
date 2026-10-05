// One-shot acceptance drill. Runs every required scenario in a fixed order,
// printing request, response and verdict per step. Exit 0 = all pass,
// non-zero = first failing scenario is named.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildApp } = await import('../src/api/server.ts');
const { LintStore } = await import('../src/state/store.ts');
const { DEFAULT_CONFIG } = await import('../src/config/config.ts');

let failures = 0;
let stepNo = 0;

function verdict(ok, label, detail) {
  console.log(`  verdict: ${ok ? 'PASS' : 'FAIL'} - ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log('  detail:', JSON.stringify(detail));
  }
}
function showReq(method, path, body) {
  console.log(`  request:  ${method} ${path}${body !== undefined ? ' body=' + JSON.stringify(body) : ''}`);
}
function showRes(status, body) {
  const s = JSON.stringify(body);
  console.log(`  response: ${status} ${s.length > 300 ? s.slice(0, 300) + '...' : s}`);
}
async function req(base, method, path, body) {
  showReq(method, path, body);
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  showRes(res.status, parsed);
  return { status: res.status, body: parsed };
}
function step(name) {
  stepNo++;
  console.log(`\n[step ${stepNo}] ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), 'lint-accept-'));
const config = { ...DEFAULT_CONFIG, dbPath: join(dir, 'accept.db'), logDir: join(dir, 'logs') };
const store = new LintStore(config.dbPath);
const app = buildApp({ config, store });
const base = await app.listen({ port: 0, host: '127.0.0.1' });
console.log(`acceptance server at ${base} (db=${config.dbPath})`);

try {
  step('seed rule set (regex + AST node rules, mixed severities)');
  {
    const rules = [
      { name: 'no-eval', severity: 'error', target: { kind: 'regex', pattern: '\\beval\\s*\\(' }, message: 'eval() is forbidden' },
      { name: 'no-danger', severity: 'warning', target: { kind: 'regex', pattern: 'danger' }, message: 'danger marker' },
      { name: 'note-danger', severity: 'info', target: { kind: 'regex', pattern: 'danger' }, message: 'danger noted' },
      { name: 'no-var', severity: 'warning', target: { kind: 'node', nodeType: 'variable_declaration', pattern: '^\\s*var\\b' }, message: 'use let/const' },
      { name: 'no-require', severity: 'error', target: { kind: 'node', nodeType: 'call_expression', pattern: 'require\\(' }, message: 'use ESM import' },
    ];
    const r = await req(base, 'PUT', '/rules', { rules });
    verdict(r.status === 200 && r.body.rules.length === 5, 'rule set stored', r.body);
  }

  step('scenario A: regex rule hits the specified pattern');
  let runA;
  {
    const r = await req(base, 'POST', '/check', {
      files: [{ path: 'src/a.ts', content: 'const ok = 1;\nconst bad = eval("2+2");\n' }],
    });
    runA = r.body.runId;
    const hits = r.body.violations.filter((v) => v.rule === 'no-eval');
    verdict(
      r.status === 200 && hits.length === 1 && hits[0].line === 2 && hits[0].file === 'src/a.ts'
        && hits[0].severity === 'error' && hits[0].message === 'eval() is forbidden',
      'no-eval hit at src/a.ts:2 with error severity',
      r.body,
    );
  }

  step('scenario B: AST node-type matching (import_statement + variable_declaration)');
  {
    const r = await req(base, 'POST', '/check', {
      files: [{ path: 'src/b.ts', content: 'const fs = require("fs");\nvar x = 1;\nlet y = 2;\n' }],
    });
    const reqs = r.body.violations.filter((v) => v.rule === 'no-require');
    const vars = r.body.violations.filter((v) => v.rule === 'no-var');
    verdict(
      reqs.length === 1 && reqs[0].line === 1 && vars.length === 1 && vars[0].line === 2,
      'require() import flagged at line 1, var flagged at line 2, let untouched',
      r.body.violations,
    );
  }

  step('scenario C: multiple rules at same position sorted by severity desc');
  {
    const r = await req(base, 'POST', '/check', {
      files: [{ path: 'src/c.ts', content: 'const x = danger;\n' }],
      persist: false,
    });
    const order = r.body.violations.map((v) => v.rule + ':' + v.severity);
    verdict(
      JSON.stringify(order) === JSON.stringify(['no-danger:warning', 'note-danger:info']),
      'same-position hits ordered warning before info',
      order,
    );
  }

  step('scenario D: rule enable/disable affects evaluation');
  {
    await req(base, 'PATCH', '/rules/no-danger', { enabled: false });
    const r = await req(base, 'POST', '/check', {
      files: [{ path: 'src/c.ts', content: 'const x = danger;\n' }],
      persist: false,
    });
    const rules = r.body.violations.map((v) => v.rule);
    await req(base, 'PATCH', '/rules/no-danger', { enabled: true });
    verdict(rules.length === 1 && rules[0] === 'note-danger', 'disabled rule produces no violations', rules);
  }

  step('scenario E: diff between two checks (added / removed)');
  {
    const r1 = await req(base, 'POST', '/check', {
      files: [{ path: 'src/d.ts', content: 'eval("1");\nconst x = danger;\n' }],
    });
    const r2 = await req(base, 'POST', '/check', {
      files: [{ path: 'src/d.ts', content: 'const safe = 1;\nconst y = eval("2");\n' }],
    });
    const d = await req(base, 'GET', `/diff?from=${r1.body.runId}&to=${r2.body.runId}`);
    const added = d.body.added.map((v) => v.rule + '@' + v.line);
    const removed = d.body.removed.map((v) => v.rule + '@' + v.line);
    verdict(
      d.body.added.length === 1 && added[0] === 'no-eval@2'
        && d.body.removed.length === 3
        && removed.includes('no-eval@1') && removed.includes('no-danger@2') && removed.includes('note-danger@2'),
      'added=[no-eval@line2], removed=[no-eval@line1, no-danger@line2, note-danger@line2]',
      { added, removed },
    );
  }

  step('scenario F: error categories are distinguishable (not uniform success)');
  {
    const bad = await req(base, 'POST', '/rules', { name: 'broken', severity: 'error', target: { kind: 'regex', pattern: '([' } });
    const ok1 = bad.status === 400 && bad.body.error.category === 'INPUT_ERROR';
    const dup = await req(base, 'POST', '/rules', { name: 'no-eval', severity: 'error', target: { kind: 'regex', pattern: 'x' } });
    const ok2 = dup.status === 409 && dup.body.error.category === 'STATE_CONFLICT';
    const nf = await req(base, 'GET', '/runs/9999');
    const ok3 = nf.status === 404 && nf.body.error.category === 'NOT_FOUND';
    verdict(ok1 && ok2 && ok3, 'INPUT_ERROR=400, STATE_CONFLICT=409, NOT_FOUND=404', { bad: bad.status, dup: dup.status, nf: nf.status });
  }

  step('scenario G: resource exhaustion is reported, not swallowed');
  {
    const big = 'const x = "' + 'a'.repeat(config.limits.maxSourceBytes + 10) + '";';
    const r = await req(base, 'POST', '/check', { files: [{ path: 'big.ts', content: big }], persist: false });
    verdict(r.status === 503 && r.body.error.category === 'RESOURCE_EXHAUSTED', 'oversized source -> 503 RESOURCE_EXHAUSTED', r.body);
  }

  step('scenario H: run history persisted and listable');
  {
    const r = await req(base, 'GET', '/runs');
    verdict(r.status === 200 && r.body.runs.length >= 4 && r.body.runs[0].status === 'completed',
      'runs listed with completed status', r.body.runs?.length);
  }
} catch (err) {
  failures++;
  console.error('unexpected acceptance error:', err);
} finally {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n========================================`);
console.log(failures === 0 ? `ACCEPTANCE: ALL ${stepNo} SCENARIOS PASSED` : `ACCEPTANCE: ${failures} FAILURE(S) in ${stepNo} scenarios`);
process.exit(failures === 0 ? 0 : 1);
