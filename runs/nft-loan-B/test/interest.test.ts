import { test } from "node:test";
import assert from "node:assert/strict";
import { interestOf, debtOf } from "../src/kernel/engine.js";

// Reference vector from the spec: principal=1003, perTickBps=5, elapsed=7
// -> interest = floor(35.105) = 35, payable = 1038.
test("interest vector: floor(1003*5*7/1000) = 35, debt = 1038", () => {
  // Independent arithmetic (not the kernel's own code path).
  const expected = Number((1003n * 5n * 7n) / 1000n);
  assert.equal(expected, 35);
  assert.equal(interestOf(1003, 5, 7), expected);
  assert.equal(debtOf({ principal: 1003, per_tick_bps: 5, borrow_tick: 10 }, 17), 1038);
});

test("interest is zero at borrow tick and floors non-divisible results", () => {
  assert.equal(interestOf(1003, 5, 0), 0);
  assert.equal(interestOf(1003, 5, 1), 5); // 5.015 -> 5
  assert.equal(interestOf(1, 1, 1), 0); // 0.001 -> 0
});
