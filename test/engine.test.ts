import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRun } from "../src/engine.ts";
import { startTarget } from "./helpers.ts";

test("engine: low concurrency, all success, no result lost", async () => {
  const target = await startTarget();
  try {
    const results = await executeRun({
      targetUrl: target.url + "/ok", concurrency: 2, totalRequests: 10,
      requestIntervalMs: 0, timeoutMs: 2000,
    });
    assert.equal(results.length, 10);
    assert.deepEqual(results.map((r) => r.seq).sort((a, b) => a - b), [0,1,2,3,4,5,6,7,8,9]);
    for (const r of results) {
      assert.equal(r.outcome, "success");
      assert.equal(r.statusCode, 200);
      assert.equal(r.failureKind, null);
      assert.ok(r.latencyMs >= 0);
    }
    assert.equal(target.counts["/ok"], 10);
  } finally {
    await target.close();
  }
});

test("engine: mixed success/http_error classified separately", async () => {
  const target = await startTarget();
  try {
    const results = await executeRun({
      targetUrl: target.url + "/flaky", concurrency: 3, totalRequests: 10,
      requestIntervalMs: 0, timeoutMs: 2000,
    });
    assert.equal(results.length, 10);
    const ok = results.filter((r) => r.outcome === "success");
    const bad = results.filter((r) => r.outcome === "failure");
    assert.equal(ok.length, 5);
    assert.equal(bad.length, 5);
    for (const r of bad) {
      assert.equal(r.failureKind, "http_error");
      assert.equal(r.statusCode, 500);
    }
  } finally {
    await target.close();
  }
});

test("engine: timeouts classified as timeout", async () => {
  const target = await startTarget();
  try {
    const results = await executeRun({
      targetUrl: target.url + "/slow?ms=300", concurrency: 2, totalRequests: 4,
      requestIntervalMs: 0, timeoutMs: 50,
    });
    assert.equal(results.length, 4);
    for (const r of results) {
      assert.equal(r.outcome, "failure");
      assert.equal(r.failureKind, "timeout");
      assert.equal(r.statusCode, null);
      assert.ok(r.latencyMs < 300, `latency ${r.latencyMs} should be well below server delay`);
    }
  } finally {
    await target.close();
  }
});

test("engine: connection refused classified as network_error", async () => {
  // Port 1 is reserved and effectively always closed on loopback.
  const results = await executeRun({
    targetUrl: "http://127.0.0.1:1/down", concurrency: 1, totalRequests: 3,
    requestIntervalMs: 0, timeoutMs: 1000,
  });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.outcome, "failure");
    assert.equal(r.failureKind, "network_error");
    assert.equal(r.statusCode, null);
  }
});

test("engine: interval is honored between requests of a worker", async () => {
  const target = await startTarget();
  try {
    const t0 = Date.now();
    await executeRun({
      targetUrl: target.url + "/ok", concurrency: 1, totalRequests: 3,
      requestIntervalMs: 60, timeoutMs: 2000,
    });
    const elapsed = Date.now() - t0;
    // 2 intervals between 3 sequential requests.
    assert.ok(elapsed >= 110, `elapsed ${elapsed}ms < expected ~120ms`);
  } finally {
    await target.close();
  }
});
