import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.ts";
import { makeFixture } from "./helpers.ts";

test("concurrent consumers: no lost updates, balance conserved", async () => {
  const LIMIT = 50;
  const { kernel, store } = makeFixture({ global: LIMIT, org: LIMIT, project: LIMIT });
  const CONSUMERS = 20;
  const ATTEMPTS_PER_CONSUMER = 5; // 100 attempts against a limit of 50

  const results = await Promise.all(
    Array.from({ length: CONSUMERS }, () =>
      (async () => {
        const out = { ok: 0, exhausted: 0 };
        for (let i = 0; i < ATTEMPTS_PER_CONSUMER; i++) {
          await Promise.resolve(); // yield to interleave consumers
          try {
            kernel.consume("ak_test", 1);
            out.ok++;
          } catch (err) {
            assert.ok(err instanceof AppError && err.code === "QUOTA_EXHAUSTED");
            out.exhausted++;
          }
        }
        return out;
      })(),
    ),
  );

  const succeeded = results.reduce((n, r) => n + r.ok, 0);
  const rejected = results.reduce((n, r) => n + r.exhausted, 0);
  assert.equal(succeeded, LIMIT, "exactly LIMIT deductions may succeed");
  assert.equal(succeeded + rejected, CONSUMERS * ATTEMPTS_PER_CONSUMER);

  // conservation: every tier reflects exactly the successful deductions
  for (const id of ["g1", "o1", "p1"]) {
    assert.equal(store.getScope(id)!.quota_used, LIMIT);
  }
  assert.equal(kernel.usage("ak_test").consumedTotal, LIMIT);
});

test("concurrent mixed amounts never overshoot the tightest tier", async () => {
  const { kernel, store } = makeFixture({ global: 1000, org: 1000, project: 40 });
  const amounts = [7, 13, 5, 20, 9, 11, 3, 17];
  const results = await Promise.all(
    amounts.map((a) =>
      Promise.resolve().then(() => {
        try {
          kernel.consume("ak_test", a);
          return { a, ok: true };
        } catch (err) {
          assert.ok(err instanceof AppError && err.code === "QUOTA_EXHAUSTED");
          return { a, ok: false };
        }
      }),
    ),
  );
  const accepted = results.filter((r) => r.ok).reduce((n, r) => n + r.a, 0);
  assert.ok(accepted <= 40, `accepted ${accepted} exceeds project limit`);
  // every tier moved by exactly the accepted total: no partial deductions
  for (const id of ["g1", "o1", "p1"]) {
    assert.equal(store.getScope(id)!.quota_used, accepted);
  }
});

