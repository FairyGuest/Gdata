import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFixture, throwsApp } from "./helpers.ts";

test("rotation: new key works, old key works inside grace window", () => {
  const { kernel } = makeFixture({ global: 100, org: 100, project: 100 });
  const { newKey, graceUntil } = kernel.rotate("ak_test", 60_000);
  assert.notEqual(newKey, "ak_test");
  assert.ok(graceUntil > 0);
  kernel.consume(newKey, 1);
  kernel.consume("ak_test", 1); // still inside grace
  // both keys share the same scope chain: 2 total deducted
  const usage = kernel.usage(newKey);
  assert.equal(usage.scopes.find((s) => s.tier === "global")!.used, 2);
  // per-key counters stay separate
  assert.equal(kernel.usage(newKey).consumedTotal, 1);
  assert.equal(kernel.usage("ak_test").consumedTotal, 1);
});

test("grace boundary: valid at graceUntil, expired one ms after", () => {
  const { kernel, clock } = makeFixture({ global: 100, org: 100, project: 100 });
  const { graceUntil } = kernel.rotate("ak_test", 60_000);
  clock.set(graceUntil);
  kernel.consume("ak_test", 1); // exactly at the boundary: still valid
  clock.set(graceUntil + 1);
  const err = throwsApp(() => kernel.consume("ak_test", 1));
  assert.equal(err.code, "KEY_EXPIRED");
  assert.equal(err.category, "state");
  assert.equal(err.httpStatus, 410);
  // old key stays expired; usage still queryable
  clock.advance(1_000_000);
  const usage = kernel.usage("ak_test");
  assert.equal(usage.status, "rotated");
});

test("zero grace period expires the old key immediately", () => {
  const { kernel, clock } = makeFixture({ global: 100, org: 100, project: 100 });
  kernel.rotate("ak_test", 0);
  clock.advance(1);
  const err = throwsApp(() => kernel.consume("ak_test", 1));
  assert.equal(err.code, "KEY_EXPIRED");
});

test("double rotation of the same key is a state conflict", () => {
  const { kernel } = makeFixture({ global: 100, org: 100, project: 100 });
  kernel.rotate("ak_test", 1000);
  const err = throwsApp(() => kernel.rotate("ak_test", 1000));
  assert.equal(err.code, "ROTATION_CONFLICT");
  assert.equal(err.category, "state");
  assert.equal(err.httpStatus, 409);
});

test("rotating an unknown key is KEY_NOT_FOUND", () => {
  const { kernel } = makeFixture({ global: 1, org: 1, project: 1 });
  const err = throwsApp(() => kernel.rotate("ghost", 1000));
  assert.equal(err.code, "KEY_NOT_FOUND");
});

