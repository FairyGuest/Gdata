import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDatasetSchema } from "../src/schema.ts";
import { ConstraintConflictError, ValidationError } from "../src/errors.ts";

test("accepts a valid schema with all supported types", () => {
  const schema = parseDatasetSchema({
    fields: {
      name: { type: "string", minLength: 2, maxLength: 8 },
      age: { type: "integer", min: 18, max: 65 },
      role: { type: "enum", values: ["admin", "user"] },
      hired: { type: "date", min: "2020-01-01", max: "2024-12-31" },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      address: { type: "object", properties: { zip: { type: "string", pattern: "^[0-9]{5}$" } } },
    },
  });
  assert.equal(Object.keys(schema.fields).length, 6);
});

test("rejects integer min > max as CONSTRAINT_CONFLICT", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { age: { type: "integer", min: 10, max: 5 } } }),
    (err: unknown) => err instanceof ConstraintConflictError && err.code === "CONSTRAINT_CONFLICT" && err.httpStatus === 422,
  );
});

test("rejects string minLength > maxLength as CONSTRAINT_CONFLICT", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { s: { type: "string", minLength: 9, maxLength: 2 } } }),
    (err: unknown) => err instanceof ConstraintConflictError && err.code === "CONSTRAINT_CONFLICT",
  );
});

test("rejects date min after max as CONSTRAINT_CONFLICT", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { d: { type: "date", min: "2025-01-01", max: "2020-01-01" } } }),
    (err: unknown) => err instanceof ConstraintConflictError && err.code === "CONSTRAINT_CONFLICT",
  );
});

test("rejects empty enum values as CONSTRAINT_CONFLICT", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { e: { type: "enum", values: [] } } }),
    (err: unknown) => err instanceof ConstraintConflictError && err.code === "CONSTRAINT_CONFLICT",
  );
});

test("rejects array minItems > maxItems as CONSTRAINT_CONFLICT", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { a: { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 1 } } }),
    (err: unknown) => err instanceof ConstraintConflictError && err.code === "CONSTRAINT_CONFLICT",
  );
});

test("rejects unknown field type as SCHEMA_VALIDATION", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { x: { type: "boolean" } } }),
    (err: unknown) => err instanceof ValidationError && err.code === "SCHEMA_VALIDATION" && err.httpStatus === 400,
  );
});

test("rejects invalid regex as SCHEMA_VALIDATION", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { x: { type: "string", pattern: "([a-z" } } }),
    (err: unknown) => err instanceof ValidationError && err.code === "SCHEMA_VALIDATION",
  );
});

test("rejects non-integer bounds as SCHEMA_VALIDATION", () => {
  assert.throws(
    () => parseDatasetSchema({ fields: { x: { type: "integer", min: 1.5 } } }),
    (err: unknown) => err instanceof ValidationError && err.code === "SCHEMA_VALIDATION",
  );
});
