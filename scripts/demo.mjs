// Local demo: boots the service, seeds config/rules.seed.json, runs two
// checks against sample sources and prints the diff. Read-only w.r.t. repo:
// uses a temp database.
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildApp } = await import('../src/api/server.ts');
const { LintStore } = await import('../src/state/store.ts');
const { DEFAULT_CONFIG } = await import('../src/config/config.ts');

const dir = mkdtempSync(join(tmpdir(), 'lint-demo-'));
const config = { ...DEFAULT_CONFIG, dbPath: join(dir, 'demo.db'), logDir: join(dir, 'logs') };
const store = new LintStore(config.dbPath);
const app = buildApp({ config, store });
const base = await app.listen({ port: 0, host: '127.0.0.1' });
console.log('demo server:', base);

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.status === 204 ? null : res.json();
};

const seed = JSON.parse(readFileSync(new URL('../config/rules.seed.json', import.meta.url), 'utf8'));
await call('PUT', '/rules', { rules: seed });
console.log('seeded rules:', seed.map((r) => `${r.name}(${r.severity},${r.enabled ? 'on' : 'off'})`).join(', '));

const v1 = await call('POST', '/check', {
  files: [{ path: 'src/sample.ts', content: 'const x = eval("1+1"); // TODO: remove\nvar y = 2;\n' }],
});
console.log(`\ncheck #1 (run ${v1.runId}):`);
for (const v of v1.violations) console.log(`  ${v.file}:${v.line} [${v.severity}] ${v.rule}: ${v.message}  | ${v.excerpt}`);

const v2 = await call('POST', '/check', {
  files: [{ path: 'src/sample.ts', content: 'const x = 1 + 1;\nvar y = 2;\nconst z = eval("3");\n' }],
});
console.log(`\ncheck #2 (run ${v2.runId}):`);
for (const v of v2.violations) console.log(`  ${v.file}:${v.line} [${v.severity}] ${v.rule}: ${v.message}  | ${v.excerpt}`);

const diff = await call('GET', `/diff?from=${v1.runId}&to=${v2.runId}`);
console.log(`\ndiff run ${v1.runId} -> ${v2.runId}:`);
console.log('  added:  ', diff.added.map((v) => `${v.rule}@L${v.line}`).join(', ') || '(none)');
console.log('  removed:', diff.removed.map((v) => `${v.rule}@L${v.line}`).join(', ') || '(none)');

await app.close();
store.close();
rmSync(dir, { recursive: true, force: true });
