import test from "node:test";
import assert from "node:assert/strict";
import { discoverTests } from "../src/contract/parser.ts";
import { runSuite } from "../src/kernel/runner.ts";
import { adaptAll } from "../src/status/adapter.ts";
import type { RunEvent } from "../src/contract/types.ts";

test("kernel executes pass/fail/timeout cases independently", async () => {
  const files = await discoverTests("tests/fixtures/suite", "**/*.test.js");
  const events: RunEvent[] = [];
  const outcome = await runSuite({ files, parallel: 3, timeoutMs: 400, onEvent: (e) => events.push(e) });
  const results = adaptAll(files, outcome.outcomes);
  const byId = new Map(results.map((r) => [r.caseId, r]));

  // Expected results are hardcoded, not derived from the kernel.
  assert.equal(byId.get("ok.test.js#ok one")!.status, "passed");
  assert.equal(byId.get("ok.test.js#ok two")!.status, "passed");
  assert.equal(byId.get("boom.test.js#explodes")!.status, "failed");
  assert.match(byId.get("boom.test.js#explodes")!.error!.message, /kaboom-fixture/);
  const hung = byId.get("hang.test.js#never ends")!;
  assert.equal(hung.status, "timeout");
  assert.ok(hung.durationMs >= 380, "timeout duration should reflect actual elapsed time, got " + hung.durationMs);
  assert.ok(hung.durationMs < 5000, "hung worker must be terminated promptly, got " + hung.durationMs);

  // Run id present on every event so a run can be replayed from logs.
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.runId === outcome.runId));
  assert.ok(events.some((e) => e.event === "case-timeout" && /terminated/.test(e.reason)));
});

test("dependency order is respected", async () => {
  const files = await discoverTests("demo/ordered", "**/*.test.js");
  const events: RunEvent[] = [];
  const outcome = await runSuite({ files, parallel: 2, timeoutMs: 2000, onEvent: (e) => events.push(e) });
  const results = adaptAll(files, outcome.outcomes);
  assert.ok(results.every((r) => r.status === "passed"));
  const startA = events.findIndex((e) => e.caseId === "dep-a.test.js#producer writes marker" && e.event === "case-running");
  const startB = events.findIndex((e) => e.caseId === "dep-b.test.js#consumer sees marker from dependency" && e.event === "case-running");
  assert.ok(startA !== -1 && startB !== -1 && startA < startB, "dependency must run before dependent");
});
