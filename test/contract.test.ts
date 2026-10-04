import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConsume, parseProvision, parseRotate } from "../src/contract.ts";
import type { AppError } from "../src/errors.ts";
import { throwsApp } from "./helpers.ts";

function expectValidation(fn: () => unknown): AppError {
  const err = throwsApp(fn);
  assert.equal(err.code, "VALIDATION_ERROR");
  assert.equal(err.category, "input");
  assert.equal(err.httpStatus, 400);
  return err;
}

test("provision contract: happy path", () => {
  const parsed = parseProvision({
    key: "k1",
    scopes: [
      { tier: "global", id: "g", limit: 10 },
      { tier: "org", id: "o", limit: 5 },
      { tier: "project", id: "p", limit: 1 },
    ],
  });
  assert.equal(parsed.key, "k1");
  assert.equal(parsed.scopes.length, 3);
});

test("provision contract: rejects malformed bodies with input errors", () => {
  expectValidation(() => parseProvision(null));
  expectValidation(() => parseProvision({ scopes: [] }));
  expectValidation(() =>
    parseProvision({
      key: "k",
      scopes: [
        { tier: "global", id: "g", limit: 1 },
        { tier: "global", id: "g2", limit: 1 },
        { tier: "org", id: "o", limit: 1 },
      ],
    }),
  );
  expectValidation(() =>
    parseProvision({
      key: "k",
      scopes: [
        { tier: "global", id: "g", limit: -1 },
        { tier: "org", id: "o", limit: 1 },
        { tier: "project", id: "p", limit: 1 },
      ],
    }),
  );
});

test("consume contract: amount must be a positive integer", () => {
  assert.deepEqual(parseConsume({ key: "k", amount: 3 }), { key: "k", amount: 3 });
  expectValidation(() => parseConsume({ key: "k", amount: 0 }));
  expectValidation(() => parseConsume({ key: "k", amount: 1.5 }));
  expectValidation(() => parseConsume({ key: "k", amount: "3" }));
  expectValidation(() => parseConsume({ amount: 3 }));
});

test("rotate contract: graceMs optional with default, must be non-negative", () => {
  assert.deepEqual(parseRotate({ key: "k" }, 5000), { key: "k", graceMs: 5000 });
  assert.deepEqual(parseRotate({ key: "k", graceMs: 0 }, 5000), { key: "k", graceMs: 0 });
  expectValidation(() => parseRotate({ key: "k", graceMs: -1 }, 5000));
});

