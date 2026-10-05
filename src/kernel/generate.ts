import { Rng, type Seed } from './rng.ts';
import { FactoryError } from '../contract/errors.ts';
import type { DatasetSchema, FieldSchema, Limits } from '../contract/schema.ts';
import { createRunLog, logStep, type RunLog } from '../diagnostics/runlog.ts';

const DEFAULT_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface GenerateResult {
  runId: string;
  rows: Record<string, unknown>[];
  log: RunLog;
}

function genString(field: Extract<FieldSchema, { kind: 'string' }>, rng: Rng, limits: Limits, path: string): string {
  const charset = field.charset ?? DEFAULT_CHARSET;
  const length = rng.int(field.minLength, field.maxLength);
  const make = (): string => {
    let out = '';
    for (let i = 0; i < length; i++) out += charset[rng.int(0, charset.length - 1)];
    return out;
  };
  if (!field.pattern) return make();
  const re = new RegExp(field.pattern);
  for (let attempt = 1; attempt <= limits.maxPatternAttempts; attempt++) {
    const candidate = make();
    if (re.test(candidate)) return candidate;
  }
  throw new FactoryError(
    'COMPUTE_FAILURE',
    path + ': unable to generate a string matching pattern ' + field.pattern +
      ' within ' + limits.maxPatternAttempts + ' attempts',
    { pattern: field.pattern, charset, minLength: field.minLength, maxLength: field.maxLength },
  );
}

function genField(field: FieldSchema, rng: Rng, limits: Limits, path: string): unknown {
  switch (field.kind) {
    case 'string':
      return genString(field, rng, limits, path);
    case 'integer':
      return rng.int(field.min, field.max);
    case 'enum':
      return rng.pick(field.values);
    case 'date': {
      const lo = Date.parse(field.min);
      const hi = Date.parse(field.max);
      const ts = lo + Math.floor(rng.next() * (hi - lo + 1));
      return new Date(ts).toISOString().slice(0, 10);
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(field.properties)) {
        out[key] = genField(sub, rng, limits, path + '.' + key);
      }
      return out;
    }
    case 'array': {
      const n = rng.int(field.minItems, field.maxItems);
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(genField(field.items, rng, limits, path + '[' + i + ']'));
      return out;
    }
  }
}

export function generateRow(schema: DatasetSchema, rng: Rng, limits: Limits): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    row[name] = genField(field, rng, limits, 'fields.' + name);
  }
  return row;
}

export function generateDataset(
  schema: DatasetSchema,
  seed: Seed,
  count: number,
  limits: Limits,
): GenerateResult {
  const log = createRunLog(seed);
  logStep(log, 'validate', 'checked count against limits', { count, maxCount: limits.maxCount });
  if (!Number.isInteger(count) || count < 1) {
    log.outcome = 'failure';
    log.failureCategory = 'INPUT_ERROR';
    throw new FactoryError('INPUT_ERROR', 'count must be a positive integer', { count });
  }
  if (count > limits.maxCount) {
    log.outcome = 'failure';
    log.failureCategory = 'RESOURCE_EXHAUSTED';
    throw new FactoryError('RESOURCE_EXHAUSTED', 'count ' + count + ' exceeds maxCount ' + limits.maxCount, { count });
  }
  const rng = new Rng(seed);
  const rows: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < count; i++) {
      rows.push(generateRow(schema, rng, limits));
    }
  } catch (err) {
    log.outcome = 'failure';
    log.failureCategory = err instanceof FactoryError ? err.category : 'COMPUTE_FAILURE';
    logStep(log, 'generate', 'generation aborted', { rowIndex: rows.length, reason: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  logStep(log, 'generate', 'generated rows deterministically from seed', { seed, rows: rows.length });
  log.outcome = 'success';
  return { runId: log.runId, rows, log };
}
