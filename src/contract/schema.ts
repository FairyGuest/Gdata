import { FactoryError } from './errors.ts';

export type Primitive = string | number | boolean | null;

export interface StringField {
  kind: 'string';
  minLength: number;
  maxLength: number;
  pattern?: string;
  charset?: string;
}
export interface IntegerField {
  kind: 'integer';
  min: number;
  max: number;
}
export interface EnumField {
  kind: 'enum';
  values: Primitive[];
}
export interface DateField {
  kind: 'date';
  min: string;
  max: string;
}
export interface ObjectField {
  kind: 'object';
  properties: Record<string, FieldSchema>;
}
export interface ArrayField {
  kind: 'array';
  items: FieldSchema;
  minItems: number;
  maxItems: number;
}
export type FieldSchema =
  | StringField
  | IntegerField
  | EnumField
  | DateField
  | ObjectField
  | ArrayField;

export interface DatasetSchema {
  fields: Record<string, FieldSchema>;
}

export interface Limits {
  maxCount: number;
  maxArrayItems: number;
  maxStringLength: number;
  maxPatternAttempts: number;
  maxNestingDepth: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string, path: string, details?: unknown): never {
  throw new FactoryError('INPUT_ERROR', path + ': ' + message, details);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optNumber(raw: Record<string, unknown>, key: string, dflt: number, path: string): number {
  const v = raw[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(key + ' must be a finite number', path);
  return v;
}

function parseDate(value: unknown, path: string, key: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(key + ' must be an ISO date YYYY-MM-DD', path, { got: value });
  }
  return value as string;
}

export function parseField(raw: unknown, path: string, limits: Limits, depth = 0): FieldSchema {
  if (depth > limits.maxNestingDepth) {
    throw new FactoryError('RESOURCE_EXHAUSTED', path + ': nesting depth exceeds limit ' + limits.maxNestingDepth);
  }
  if (!isPlainObject(raw)) fail('field definition must be an object', path);
  const kind = raw.kind;
  if (typeof kind !== 'string') fail('missing "kind"', path);

  switch (kind) {
    case 'string': {
      const minLength = optNumber(raw, 'minLength', 1, path);
      const maxLength = optNumber(raw, 'maxLength', 16, path);
      if (!Number.isInteger(minLength) || minLength < 0) fail('minLength must be a non-negative integer', path);
      if (!Number.isInteger(maxLength) || maxLength < 0) fail('maxLength must be a non-negative integer', path);
      if (minLength > maxLength) {
        fail('constraint conflict: minLength (' + minLength + ') > maxLength (' + maxLength + ')', path);
      }
      if (maxLength > limits.maxStringLength) {
        throw new FactoryError('RESOURCE_EXHAUSTED', path + ': maxStringLength ' + limits.maxStringLength + ' exceeded');
      }
      let pattern: string | undefined;
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== 'string') fail('pattern must be a string', path);
        try {
          new RegExp(raw.pattern as string);
        } catch {
          fail('pattern is not a valid regex: ' + String(raw.pattern), path);
        }
        pattern = raw.pattern as string;
      }
      let charset: string | undefined;
      if (raw.charset !== undefined) {
        if (typeof raw.charset !== 'string' || (raw.charset as string).length === 0) {
          fail('charset must be a non-empty string', path);
        }
        charset = raw.charset as string;
      }
      return { kind: 'string', minLength, maxLength, pattern, charset };
    }
    case 'integer': {
      const min = optNumber(raw, 'min', 0, path);
      const max = optNumber(raw, 'max', 100, path);
      if (!Number.isInteger(min) || !Number.isInteger(max)) fail('min/max must be integers', path);
      if (min > max) fail('constraint conflict: min (' + min + ') > max (' + max + ')', path);
      return { kind: 'integer', min, max };
    }
    case 'enum': {
      const values = raw.values;
      if (!Array.isArray(values) || values.length === 0) fail('enum requires a non-empty "values" array', path);
      for (const v of values) {
        const t = typeof v;
        if (v !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
          fail('enum values must be primitives (string/number/boolean/null)', path);
        }
      }
      return { kind: 'enum', values: values as Primitive[] };
    }
    case 'date': {
      const min = parseDate(raw.min ?? '1970-01-01', path, 'min');
      const max = parseDate(raw.max ?? '2100-12-31', path, 'max');
      if (Date.parse(min) > Date.parse(max)) {
        fail('constraint conflict: min (' + min + ') is after max (' + max + ')', path);
      }
      return { kind: 'date', min, max };
    }
    case 'object': {
      const props = raw.properties;
      if (!isPlainObject(props) || Object.keys(props).length === 0) {
        fail('object requires a non-empty "properties" map', path);
      }
      const properties: Record<string, FieldSchema> = {};
      for (const [key, value] of Object.entries(props)) {
        properties[key] = parseField(value, path + '.' + key, limits, depth + 1);
      }
      return { kind: 'object', properties };
    }
    case 'array': {
      if (raw.items === undefined) fail('array requires "items"', path);
      const minItems = optNumber(raw, 'minItems', 0, path);
      const maxItems = optNumber(raw, 'maxItems', 8, path);
      if (!Number.isInteger(minItems) || minItems < 0) fail('minItems must be a non-negative integer', path);
      if (!Number.isInteger(maxItems) || maxItems < 0) fail('maxItems must be a non-negative integer', path);
      if (minItems > maxItems) {
        fail('constraint conflict: minItems (' + minItems + ') > maxItems (' + maxItems + ')', path);
      }
      if (maxItems > limits.maxArrayItems) {
        throw new FactoryError('RESOURCE_EXHAUSTED', path + ': maxArrayItems ' + limits.maxArrayItems + ' exceeded');
      }
      const items = parseField(raw.items, path + '[]', limits, depth + 1);
      return { kind: 'array', items, minItems, maxItems };
    }
    default:
      fail('unknown kind "' + kind + '"', path);
  }
}

export function parseSchema(raw: unknown, limits: Limits): DatasetSchema {
  if (!isPlainObject(raw) || !isPlainObject(raw.fields) || Object.keys(raw.fields).length === 0) {
    throw new FactoryError('INPUT_ERROR', 'schema must be { "fields": { <name>: <field>, ... } } with at least one field');
  }
  const fields: Record<string, FieldSchema> = {};
  for (const [name, def] of Object.entries(raw.fields)) {
    fields[name] = parseField(def, 'fields.' + name, limits);
  }
  return { fields };
}
