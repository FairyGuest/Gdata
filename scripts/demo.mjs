// Local demo: boots the service, runs the mixed fixture, prints the report.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4392;
const BASE = 'http://127.0.0.1:' + PORT;

const service = spawn(process.execPath, [path.join(root, 'src', 'index.ts')], {
  env: { ...process.env, MUTATION_PORT: String(PORT), MUTATION_DB: path.join(root, 'data', 'demo.db') },
  stdio: 'inherit',
});

const waitHealthy = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('service did not start');
};

await waitHealthy();
const res = await fetch(BASE + '/runs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectDir: path.join(root, 'fixtures', 'mixed-project'), sourceFile: 'src/calc.js' }),
});
const report = await res.json();
console.log('\n=== mutation report ' + report.runId + ' ===');
console.log('score: ' + (report.score * 100).toFixed(1) + '% (' + report.killed + '/' + report.total + ' killed)');
for (const m of report.mutants) {
  console.log('  ' + m.id + ' ' + m.mutator.padEnd(15) + m.status.toUpperCase().padEnd(9) + m.preview);
}
console.log('survivors: ' + report.survivors.map((m) => m.id + ' (' + m.mutator + ')').join(', '));
service.kill();
