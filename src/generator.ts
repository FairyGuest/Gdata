/**
 * Execution kernel: recursive, deterministic data generation.
 * Pure with respect to (schema, seed, limits) — no I/O, no clock, no Math.random.
 */
import { ComputationError, ResourceExhaustedError } from "./errors.ts";
import { SeededRandom } from "./random.ts";
import type { DatasetSchema, FieldSchema } from "./schema.ts";
import type { AppConfig } from "./config.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface GenerateOptions {
  seed: number;
  count: number;
  limits: AppConfig["limits"];
}

export interface GenerateResult {
  seed: number;
  count: number;
  rows: Record<string, unknown>[];
}

function genString(field: Extract<FieldSchema, { type: "string" }>, rng: SeededRandom, limits: AppConfig["limits"]): string {
  const min = field.minLength ?? 0;
  const max = field.maxLength ?? 16;
  const make = (): string => {
    const len = rng.int(min, max);
    let out = "";
    for (let i = 0; i < len; i++) out += ALPHABET[rng.int(0, ALPHABET.length - 1)];
    return out;
  };
  if (field.pattern === undefined) return make();
  const re = new RegExp(field.pattern);
  for (let attempt = 0; attempt < limits.maxPatternAttempts; attempt++) {
    const candidate = make();
    if (re.test(candidate)) return candidate;
  }
  throw new ComputationError(
    `unable to satisfy pattern ${field.pattern} within ${limits.maxPatternAttempts} attempts`,
    { pattern: field.pattern, minLength: min, maxLength: max },
  );
}

function genField(field: FieldSchema, rng: SeededRandom, limits: AppConfig["limits"], depth: number): unknown {
  if (depth > limits.maxDepth) {
    throw new ResourceExhaustedError(`nesting depth exceeds limit of ${limits.maxDepth}`, { depth });
  }
  switch (field.type) {
    case "string":
      return genString(field, rng, limits);
    case "integer":
      return rng.int(field.min ?? 0, field.max ?? 100);
    case "enum":
      return rng.pick(field.values);
    case "date": {
      const lo = Date.parse(field.min ?? "1970-01-01");
      const hi = Date.parse(field.max ?? "2030-12-31");
      const ts = lo + Math.floor(rng.next() * (hi - lo + 1));
      return new Date(ts).toISOString().slice(0, 10);
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(field.properties)) {
        out[key] = genField(sub, rng, limits, depth + 1);
      }
      return out;
    }
    case "array": {
      const min = field.minItems ?? 0;
      const max = field.maxItems ?? 5;
      if (max > limits.maxArrayItems) {
        throw new ResourceExhaustedError(
          `array maxItems ${max} exceeds limit of ${limits.maxArrayItems}`,
          { maxItems: max },
        );
      }
      const len = rng.int(min, max);
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) out.push(genField(field.items, rng, limits, depth + 1));
      return out;
    }
  }
}

export function generateDataset(schema: DatasetSchema, options: GenerateOptions): GenerateResult {
  if (!Number.isInteger(options.seed)) {
    throw new ComputationError("seed must be an integer", { seed: options.seed });
  }
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new ComputationError("count must be a positive integer", { count: options.count });
  }
  if (options.count > options.limits.maxRows) {
    throw new ResourceExhaustedError(
      `count ${options.count} exceeds limit of ${options.limits.maxRows}`,
      { count: options.count, maxRows: options.limits.maxRows },
    );
  }
  const rng = new SeededRandom(options.seed);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < options.count; i++) {
    const row: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(schema.fields)) {
      row[name] = genField(field, rng, options.limits, 1);
    }
    rows.push(row);
  }
  return { seed: options.seed, count: options.count, rows };
}
