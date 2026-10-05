// Local demo: runs mutation testing against fixtures/sample without HTTP.
import { MutationStore } from '../src/store/sqlite.ts';
import { MutationService } from '../src/service.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig(process.env);
console.log('[demo] executor=' + config.executor + ' db=' + config.dbPath);
const svc = new MutationService(new MutationStore(config.dbPath), config, (m) => console.log(m));

const rec = await svc.run({ projectDir: 'fixtures/sample' });
console.log('\n=== Mutation testing summary ===');
console.log('runId:    ' + rec.runId);
console.log('mutants:  ' + rec.total + '  killed: ' + rec.killed + '  survived: ' + rec.survived);
console.log('score:    ' + (rec.score * 100).toFixed(1) + '%');
console.log('\nSurviving mutants (test blind spots):');
for (const m of rec.survivors) {
  console.log('  - ' + m.file + ':' + m.line + '  ' + m.type + '  ' + m.original + ' -> ' + m.replacement);
}
console.log('\nPer-mutant detail:');
for (const r of rec.results) {
  console.log('  [' + r.status.padEnd(8) + '] ' + r.mutant.id + '  ' + r.reason);
}
process.exit(0);

