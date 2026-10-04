import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFixture, throwsApp } from "./helpers.ts";

test("three-tier deduction: all tiers debited together", () => {
  const { kernel } = makeFixture({ global: 100, org: 50, project: 10 });
  const res = kernel.consume("ak_test", 4);
  const byTier = Object.fromEntries(res.balances.map((b) => [b.tier, b]));
  assert.equal(byTier.global.used, 4);
  assert.equal(byTier.org.used, 4);
  assert.equal(byTier.project.used, 4);
  assert.equal(byTier.project.remaining, 6);
});

test("insufficient project tier rejects everything and rolls back all tiers", () => {
  const { kernel, store } = makeFixture({ global: 100, org: 50, project: 10 });
  kernel.consume("ak_test", 8);
  const err = throwsApp(() => kernel.consume("ak_test", 5));
  assert.equal(err.code, "QUOTA_EXHAUSTED");
  assert.equal(err.category, "resource");
  assert.equal(err.httpStatus, 429);
  assert.equal(err.details?.tier, "project");
  assert.equal(err.details?.remaining, 2);
  // rollback: no tier may show the rejected 5 units
  assert.equal(store.getScope("g1")!.quota_used, 8);
  assert.equal(store.getScope("o1")!.quota_used, 8);
  assert.equal(store.getScope("p1")!.quota_used, 8);
});

test("insufficient org tier also rolls back (not only project)", () => {
  const { kernel, store } = makeFixture({ global: 100, org: 3, project: 100 });
  const err = throwsApp(() => kernel.consume("ak_test", 10));
  assert.equal(err.code, "QUOTA_EXHAUSTED");
  assert.equal(err.details?.tier, "org");
  assert.equal(store.getScope("g1")!.quota_used, 0);
  assert.equal(store.getScope("o1")!.quota_used, 0);
  assert.equal(store.getScope("p1")!.quota_used, 0);
});

test("exact-limit consume succeeds, the next unit fails", () => {
  const { kernel } = makeFixture({ global: 10, org: 10, project: 10 });
  const res = kernel.consume("ak_test", 10);
  assert.ok(res.balances.every((b) => b.remaining === 0));
  const err = throwsApp(() => kernel.consume("ak_test", 1));
  assert.equal(err.code, "QUOTA_EXHAUSTED");
  assert.equal(err.details?.tier, "global");
});

test("usage endpoint reports per-key consumption and scope balances", () => {
  const { kernel } = makeFixture({ global: 100, org: 50, project: 10 });
  kernel.consume("ak_test", 3);
  kernel.consume("ak_test", 2);
  const usage = kernel.usage("ak_test");
  assert.equal(usage.consumedTotal, 5);
  assert.equal(usage.scopes.find((s) => s.tier === "project")!.used, 5);
});

test("unknown key is a state-category error, not a success", () => {
  const { kernel } = makeFixture({ global: 1, org: 1, project: 1 });
  const err = throwsApp(() => kernel.consume("nope", 1));
  assert.equal(err.code, "KEY_NOT_FOUND");
  assert.equal(err.category, "state");
  assert.equal(err.httpStatus, 404);
});

test("non-positive amount is an input-category error", () => {
  const { kernel } = makeFixture({ global: 1, org: 1, project: 1 });
  const err = throwsApp(() => kernel.consume("ak_test", 0));
  assert.equal(err.code, "VALIDATION_ERROR");
  assert.equal(err.category, "input");
});

