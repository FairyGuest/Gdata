import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpAdapter } from "../src/http-adapter.ts";
import { Store } from "../src/store.ts";
import { Runner } from "../src/runner.ts";
import { registerRoutes } from "../src/server.ts";
import { startTarget, type TargetServer } from "./helpers.ts";

let target: TargetServer;
let adapter: NodeHttpAdapter;
let store: Store;
let base: string;
let tmp: string;
const logs: string[] = [];

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function waitRun(runId: string, timeoutMs = 15000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api("GET", "/runs/" + runId);
    if (json.status !== "running") return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not finish in time: " + runId);
}

before(async () => {
  target = await startTarget();
  tmp = mkdtempSync(join(tmpdir(), "loadtest-api-"));
  store = new Store(join(tmp, "test.db"));
  const runner = new Runner(store, { logger: (l) => logs.push(l) });
  adapter = new NodeHttpAdapter();
  registerRoutes({ adapter, store, runner });
  const { port } = await adapter.listen(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await adapter.close();
  store.close();
  await target.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("api: health and diagnostics", async () => {
  const h = await api("GET", "/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.status, "ok");
  const d = await api("GET", "/diagnostics");
  assert.equal(d.status, 200);
  assert.equal(typeof d.json.activeRuns, "number");
  assert.ok(Array.isArray(d.json.recentErrors));
});

test("api: invalid config -> 400 INPUT_ERROR", async () => {
  const r = await api("POST", "/runs", { targetUrl: "nope" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "INPUT_ERROR");
});

test("api: malformed JSON body -> 400 INPUT_ERROR", async () => {
  const res = await fetch(base + "/runs", { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "INPUT_ERROR");
});

test("api: unknown run -> 404 NOT_FOUND", async () => {
  const r = await api("GET", "/runs/run-does-not-exist");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
});

test("api: all-success run produces correct summary and persisted results", async () => {
  const targetUrl = target.url + "/ok";
  const start = await api("POST", "/runs", { targetUrl, concurrency: 2, totalRequests: 10, timeoutMs: 2000 });
  assert.equal(start.status, 202);
  const run = await waitRun(start.json.runId);
  assert.equal(run.status, "completed");
  const s = run.summary;
  assert.equal(s.totalRequests, 10);
  assert.equal(s.successCount, 10);
  assert.equal(s.failureCount, 0);
  assert.deepEqual(s.failuresByKind, { http_error: 0, timeout: 0, network_error: 0 });
  assert.ok(s.successStats.count === 10);
  assert.ok(s.successStats.minMs <= s.successStats.p50Ms && s.successStats.p50Ms <= s.successStats.p90Ms
    && s.successStats.p90Ms <= s.successStats.p99Ms && s.successStats.p99Ms <= s.successStats.maxMs);
  assert.equal(s.failureStats, null);
  assert.ok(s.throughputRps > 0);
  const results = await api("GET", `/runs/${start.json.runId}/results`);
  assert.equal(results.json.results.length, 10);
  // logs carry the run id for replay
  assert.ok(logs.some((l) => l.includes(start.json.runId) && l.includes("state=completed")));
});

test("api: mixed run separates failure categories and latency stats", async () => {
  const start = await api("POST", "/runs", { targetUrl: target.url + "/flaky", concurrency: 2, totalRequests: 10, timeoutMs: 2000 });
  assert.equal(start.status, 202);
  const run = await waitRun(start.json.runId);
  const s = run.summary;
  assert.equal(s.successCount, 5);
  assert.equal(s.failureCount, 5);
  assert.equal(s.failuresByKind.http_error, 5);
  assert.equal(s.failuresByKind.timeout, 0);
  assert.equal(s.failuresByKind.network_error, 0);
  assert.ok(s.successStats && s.successStats.count === 5);
  assert.ok(s.failureStats && s.failureStats.count === 5);
});

test("api: list filters by targetUrl and time range", async () => {
  const urlA = target.url + "/ok";
  const a = await api("POST", "/runs", { targetUrl: urlA, concurrency: 1, totalRequests: 2, timeoutMs: 2000 });
  await waitRun(a.json.runId);
  const byUrl = await api("GET", "/runs?targetUrl=" + encodeURIComponent(urlA));
  assert.ok(byUrl.json.runs.length >= 1);
  for (const r of byUrl.json.runs) assert.equal(r.targetUrl, urlA);
  const future = await api("GET", "/runs?from=" + encodeURIComponent(new Date(Date.now() + 3600_000).toISOString()));
  assert.equal(future.json.count, 0);
  const badRange = await api("GET", "/runs?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z");
  assert.equal(badRange.status, 400);
  assert.equal(badRange.json.error.code, "INPUT_ERROR");
});

test("api: compare completed runs and conflict on unfinished", async () => {
  const url = target.url + "/ok";
  const r1 = await api("POST", "/runs", { targetUrl: url, concurrency: 1, totalRequests: 3, timeoutMs: 2000 });
  const r2 = await api("POST", "/runs", { targetUrl: url, concurrency: 1, totalRequests: 3, timeoutMs: 2000 });
  await waitRun(r1.json.runId);
  // r2 may still be running -> STATE_CONFLICT
  const early = await api("GET", `/runs/${r1.json.runId}/compare/${r2.json.runId}`);
  if (early.status !== 200) {
    assert.equal(early.status, 409);
    assert.equal(early.json.error.code, "STATE_CONFLICT");
  }
  await waitRun(r2.json.runId);
  const cmp = await api("GET", `/runs/${r1.json.runId}/compare/${r2.json.runId}`);
  assert.equal(cmp.status, 200);
  assert.equal(cmp.json.runA.runId, r1.json.runId);
  assert.equal(cmp.json.runB.runId, r2.json.runId);
  assert.equal(typeof cmp.json.delta.throughputRps, "number");
});
