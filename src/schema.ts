/**
 * Contract layer: schema type definitions + parsing/validation.
 * Anything crossing the HTTP boundary is validated here before it
 * reaches the generation kernel. Constraint conflicts are rejected
 * eagerly with ConstraintConflictError instead of producing bad data.
 */
import { ConstraintConflictError, ValidationError } from "./errors.ts";

export interface StringField { type: "string"; minLength?: number; maxLength?: number; pattern?: string }
export interface IntegerField { type: "integer"; min?: number; max?: number }
export interface EnumField { type: "enum"; values: string[] }
export interface DateField { type: "date"; min?: string; max?: string }
export interface ObjectField { type: "object"; properties: Record<string, FieldSchema> }
export interface ArrayField { type: "array"; items: FieldSchema; minItems?: number; maxItems?: number }

export type FieldSchema = StringField | IntegerField | EnumField | DateField | ObjectField | ArrayField;

export interface DatasetSchema {
  fields: Record<string, FieldSchema>;
}

const KNOWN_TYPES = new Set(["string", "integer", "enum", "date", "object", "array"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(path: string, message: string): never {
  throw new ValidationError(`schema invalid at "${path}": ${message}`, { path });
}

function conflict(path: string, message: string): never {
  throw new ConstraintConflictError(`constraint conflict at "${path}": ${message}`, { path });
}

function assertNonNegInt(value: unknown, name: string, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, `"${name}" must be a non-negative integer`);
  }
}

export function validateField(field: unknown, path: string): FieldSchema {
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    fail(path, "field definition must be an object");
  }
  const f = field as Record<string, unknown>;
  if (typeof f.type !== "string" || !KNOWN_TYPES.has(f.type)) {
    fail(path, `unknown or missing "type" (got ${JSON.stringify(f.type)})`);
  }

  switch (f.type) {
    case "string": {
      const { minLength = 0, maxLength = 16, pattern } = f;
      assertNonNegInt(minLength, "minLength", path);
      assertNonNegInt(maxLength, "maxLength", path);
      if ((minLength as number) > (maxLength as number)) {
        conflict(path, `minLength (${minLength}) > maxLength (${maxLength})`);
      }
      if (pattern !== undefined) {
        if (typeof pattern !== "string") fail(path, '"pattern" must be a string');
        try { new RegExp(pattern); } catch { fail(path, `invalid regex: ${pattern}`); }
      }
      return { type: "string", minLength, maxLength, pattern } as StringField;
    }
    case "integer": {
      const { min = 0, max = 100 } = f;
      if (typeof min !== "number" || !Number.isInteger(min)) fail(path, '"min" must be an integer');
      if (typeof max !== "number" || !Number.isInteger(max)) fail(path, '"max" must be an integer');
      if (min > max) conflict(path, `min (${min}) > max (${max})`);
      return { type: "integer", min, max };
    }
    case "enum": {
      if (!Array.isArray(f.values) || f.values.some((v) => typeof v !== "string")) {
        fail(path, '"values" must be an array of strings');
      }
      if (f.values.length === 0) conflict(path, "enum requires at least one value");
      return { type: "enum", values: f.values as string[] };
    }
    case "date": {
      const { min = "1970-01-01", max = "2030-12-31" } = f;
      for (const [name, v] of [["min", min], ["max", max]] as const) {
        if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
          fail(path, `"${name}" must be an ISO date (YYYY-MM-DD)`);
        }
      }
      if (Date.parse(min as string) > Date.parse(max as string)) {
        conflict(path, `min (${min}) is after max (${max})`);
      }
      return { type: "date", min, max } as DateField;
    }
    case "object": {
      if (typeof f.properties !== "object" || f.properties === null || Array.isArray(f.properties)) {
        fail(path, '"properties" must be an object');
      }
      const entries = Object.entries(f.properties as Record<string, unknown>);
      if (entries.length === 0) conflict(path, "object requires at least one property");
      const properties: Record<string, FieldSchema> = {};
      for (const [key, sub] of entries) properties[key] = validateField(sub, `${path}.${key}`);
      return { type: "object", properties };
    }
    case "array": {
      if (f.items === undefined) fail(path, '"items" is required');
      const { minItems = 0, maxItems = 5 } = f;
      assertNonNegInt(minItems, "minItems", path);
      assertNonNegInt(maxItems, "maxItems", path);
      if ((minItems as number) > (maxItems as number)) {
        conflict(path, `minItems (${minItems}) > maxItems (${maxItems})`);
      }
      return { type: "array", items: validateField(f.items, `${path}[]`), minItems, maxItems } as ArrayField;
    }
    default:
      fail(path, "unreachable");
  }
}

export function parseDatasetSchema(raw: unknown): DatasetSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError('schema must be an object with a "fields" map');
  }
  const fields = (raw as Record<string, unknown>).fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new ValidationError('schema requires a "fields" object');
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) throw new ConstraintConflictError('schema "fields" must not be empty');
  const parsed: Record<string, FieldSchema> = {};
  for (const [name, def] of entries) parsed[name] = validateField(def, name);
  return { fields: parsed };
}
