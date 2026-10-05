// Local demo: generate a reproducible dataset, persist it, verify by seed.
import { parseSchema } from '../src/contract/schema.ts';
import { generateDataset } from '../src/kernel/generate.ts';
import { DatasetStore } from '../src/state/store.ts';
import { FactoryError } from '../src/contract/errors.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const limits = config.limits;

const schema = parseSchema({
  fields: {
    id: { kind: 'integer', min: 1, max: 100 },
    name: { kind: 'string', minLength: 5, maxLength: 8 },
    role: { kind: 'enum', values: ['admin', 'user', 'guest'] },
    birthday: { kind: 'date', min: '1990-01-01', max: '2000-12-31' },
    tags: { kind: 'array', minItems: 0, maxItems: 3, items: { kind: 'string', minLength: 2, maxLength: 5 } },
  },
}, limits);

const seed = 42;
const first = generateDataset(schema, seed, 5, limits);
const second = generateDataset(schema, seed, 5, limits);
console.log('[demo] runId:', first.runId);
console.log('[demo] seed', seed, 'generated twice, identical =', JSON.stringify(first.rows) === JSON.stringify(second.rows));
console.log('[demo] sample rows:');
for (const row of first.rows) console.log('       ' + JSON.stringify(row));

const store = new DatasetStore(config.dbPath);
try {
  store.saveDataset('demo-' + seed, schema, seed, 5, limits);
  console.log('[demo] persisted dataset "demo-' + seed + '" to', config.dbPath);
} catch (e) {
  if (e instanceof FactoryError && e.category === 'STATE_CONFLICT') {
    console.log('[demo] dataset "demo-' + seed + '" already exists, skipping save');
  } else {
    throw e;
  }
}
const verification = store.verifyDataset('demo-' + seed, limits);
console.log('[demo] verify:', verification.consistent, '-', verification.reason);
store.close();
