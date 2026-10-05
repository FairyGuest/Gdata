import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDataset } from "../src/generator.ts";
import { parseDatasetSchema } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ResourceExhaustedError } from "../src/errors.ts";

const limits = DEFAULT_CONFIG.limits;

const schema = parseDatasetSchema({
  fields: {
    name: { type: "string", minLength: 3, maxLength: 6 },
    age: { type: "integer", min: 18, max: 30 },
    role: { type: "enum", values: ["admin", "user", "guest"] },
    hired: { type: "date", min: "2021-01-01", max: "2021-12-31" },
    tags: { type: "array", items: { type: "integer", min: 0, max: 9 }, minItems: 2, maxItems: 4 },
    address: {
      type: "object",
      properties: {
        zip: { type: "string", minLength: 5, maxLength: 5, pattern: "^[0-9A-Za-z]{5}$" },
        geo: { type: "object", properties: { lat: { type: "integer", min: -90, max: 90 } } },
      },
    },
  },
});

test("same seed produces byte-identical datasets across runs", () => {
  const a = generateDataset(schema, { seed: 42, count: 25, limits });
  const b = generateDataset(schema, { seed: 42, count: 25, limits });
  assert.deepEqual(a.rows, b.rows);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("different seeds produce different datasets", () => {
  const a = generateDataset(schema, { seed: 1, count: 10, limits });
  const b = generateDataset(schema, { seed: 2, count: 10, limits });
  assert.notDeepEqual(a.rows, b.rows);
});

test("seed 42 first row matches pinned reference values", () => {
  // Reference values pinned as literals so any regression in the generator
  // or PRNG breaks this test; not derived from the code under test at runtime.
  const { rows } = generateDataset(schema, { seed: 42, count: 1, limits });
  const row = rows[0];
  assert.deepEqual(row, {
    name: "B0PkG",
    age: 21,
    role: "user",
    hired: "2021-11-12",
    tags: [2, 8, 7],
    address: { zip: "mFQLa", geo: { lat: -5 } },
  });
});

test("every generated value satisfies its constraints", () => {
  const { rows } = generateDataset(schema, { seed: 7, count: 200, limits });
  for (const row of rows) {
    const name = row.name as string;
    assert.ok(name.length >= 3 && name.length <= 6, `name length ${name.length}`);
    const age = row.age as number;
    assert.ok(Number.isInteger(age) && age >= 18 && age <= 30, `age ${age}`);
    assert.ok(["admin", "user", "guest"].includes(row.role as string));
    const hired = row.hired as string;
    assert.ok(hired >= "2021-01-01" && hired <= "2021-12-31", `hired ${hired}`);
    const tags = row.tags as number[];
    assert.ok(tags.length >= 2 && tags.length <= 4);
    for (const t of tags) assert.ok(Number.isInteger(t) && t >= 0 && t <= 9);
    const address = row.address as { zip: string; geo: { lat: number } };
    assert.match(address.zip, /^[0-9A-Za-z]{5}$/);
    assert.ok(address.geo.lat >= -90 && address.geo.lat <= 90);
  }
});

test("string pattern constraint is honored on every row", () => {
  const s = parseDatasetSchema({ fields: { code: { type: "string", minLength: 4, maxLength: 4, pattern: "^[A-Z]{4}$" } } });
  const { rows } = generateDataset(s, { seed: 99, count: 50, limits });
  for (const row of rows) assert.match(row.code as string, /^[A-Z]{4}$/);
});

test("count exceeding maxRows raises RESOURCE_EXHAUSTED", () => {
  assert.throws(
    () => generateDataset(schema, { seed: 1, count: limits.maxRows + 1, limits }),
    (err: unknown) => err instanceof ResourceExhaustedError && err.code === "RESOURCE_EXHAUSTED" && err.httpStatus === 413,
  );
});

test("nesting depth beyond limit raises RESOURCE_EXHAUSTED", () => {
  let nested: unknown = { type: "integer" };
  for (let i = 0; i < limits.maxDepth + 1; i++) nested = { type: "object", properties: { next: nested } };
  const deep = parseDatasetSchema({ fields: { deep: nested } });
  assert.throws(
    () => generateDataset(deep, { seed: 1, count: 1, limits }),
    (err: unknown) => err instanceof ResourceExhaustedError && err.code === "RESOURCE_EXHAUSTED",
  );
});
