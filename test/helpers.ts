import type { Limits } from '../src/contract/schema.ts';

export const TEST_LIMITS: Limits = {
  maxCount: 1000,
  maxArrayItems: 100,
  maxStringLength: 1000,
  maxPatternAttempts: 5000,
  maxNestingDepth: 8,
};

export const DEMO_SCHEMA_RAW = {
  fields: {
    id: { kind: 'integer', min: 1, max: 100 },
    name: { kind: 'string', minLength: 5, maxLength: 5 },
    role: { kind: 'enum', values: ['admin', 'user', 'guest'] },
    birthday: { kind: 'date', min: '1990-01-01', max: '2000-12-31' },
  },
};
