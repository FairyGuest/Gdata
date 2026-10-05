import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunConfig } from "../src/config.ts";
import { AppError } from "../src/errors.ts";

test("parseRunConfig: valid minimal body applies defaults", () => {
  const c = parseRunConfig({ targetUrl: "http://127.0.0.1:9000/ok" });
  assert.equal(c.concurrency, 1);
  assert.equal(c.totalRequests, 10);
  assert.equal(c.requestIntervalMs, 0);
  assert.equal(c.timeoutMs, 10000);
});

test("parseRunConfig: rejects bad inputs with INPUT_ERROR", () => {
  const bad = [
    null,
    [],
    {},
    { targetUrl: "not-a-url" },
    { targetUrl: "ftp://x" },
    { targetUrl: "http://x", concurrency: 0 },
    { targetUrl: "http://x", concurrency: 1.5 },
    { targetUrl: "http://x", totalRequests: -3 },
    { targetUrl: "http://x", requestIntervalMs: "fast" },
    { targetUrl: "http://x", timeoutMs: 0 },
  ];
  for (const b of bad) {
    assert.throws(() => parseRunConfig(b), (e: unknown) => e instanceof AppError && e.code === "INPUT_ERROR",
      `expected INPUT_ERROR for ${JSON.stringify(b)}`);
  }
});
