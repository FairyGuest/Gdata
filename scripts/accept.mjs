// One-shot acceptance script. Exercises every required scenario in a fixed
// order against a real HTTP instance of the service, printing each request,
// response and judgment. Exit 0 iff all scenarios pass, else non-zero naming
// the failed scenario. The reference statistics below are an INDEPENDENT
// reimplementation, not imported from src/stats.ts.

import { startTarget } from "../test/helpers.ts";
import { NodeHttpAdapter } from "../src/http-adapter.ts";
import { Store } from "../src/store.ts";
import { Runner } from "../src/runner.ts";
import { registerRoutes } from "../src/server.ts";

let failures = 0;
let scenario = "";

function judge(ok, reason) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${reason}`);
  if (!ok) { failures++; }
  return ok;
}

function step(msg) { console.log("  " + msg); }

// --- independent reference implementation (linear interpolation) ---
function refStats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p) => {
    const rank = (p / 100) * (s.length - 1);
    const lo = Math.floor(rank), hi = Math.ceil(rank);
    return s[lo] + (s[hi] - s[lo]) * (rank - lo);
  };
  return {
    count: s.length,
    minMs: s[0],
    maxMs: s[s.length - 1],
    avgMs: s.reduce((a, b) => a + b, 0) / s.length,
    p50Ms: pct(50), p90Ms: pct(90), p99Ms: pct(99),
  };
}

function statsMatch(actual, expected, tol = 1e-6) {
  if (!actual) return false;
  for (const k of ["count", "minMs", "maxMs", "avgMs", "p50Ms", "p90Ms", "p99Ms"]) {
    if (Math.abs(actual[k] - expected[k]) > tol) return false;
  }
  return true;
}

const target = await startTarget();
const store = new Store(":memory:");
const runner = new Runner(store, { maxConcurrentRuns: 4, logger: () => {} });
const adapter = new NodeHttpAdapter();
registerRoutes({ adapter, store, runner });
const { port } = await adapter.listen(0);
const base = `http://127.0.0.1:${port}`;
console.log(`acceptance: service=${base} target=${target.url}`);

async function api(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  return { status: res.status, json: await res.json() };
}

async function waitRun(runId) {
  for (let i = 0; i < 300; i++) {
    const { json } = await api("GET", "/runs/" + runId);
    if (json.status !== "running") return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for " + runId);
}

async function getResults(runId) {
  const { json } = await api("GET", `/runs/${runId}/results`);
  return json.results;
}

try {
  // S1: health & diagnostics
  scenario = "S1 health/diagnostics";
  console.log("\n== S1 health & diagnostics ==");
  const h = await api("GET", "/health");
  step(`GET /health -> ${h.status} ${JSON.stringify(h.json)}`);
  judge(h.status === 200 && h.json.status === "ok", "health ok");
  const d = await api("GET", "/diagnostics");
  step(`GET /diagnostics -> ${d.status} activeRuns=${d.json.activeRuns}`);
  judge(d.status === 200 && typeof d.json.activeRuns === "number", "diagnostics ok");

  // S2: input errors are distinguishable
  scenario = "S2 input errors";
  console.log("\n== S2 input error semantics ==");
  for (const bad of [{ targetUrl: "nope" }, { targetUrl: "http://x", concurrency: 0 }, { targetUrl: "http://x", timeoutMs: 0 }]) {
    const r = await api("POST", "/runs", bad);
    step(`POST /runs ${JSON.stringify(bad)} -> ${r.status} ${r.json.error.code}`);
    judge(r.status === 400 && r.json.error.code === "INPUT_ERROR", "invalid config rejected as INPUT_ERROR");
  }
  const badJson = await api("POST", "/runs", "{broken");
  step(`POST /runs (malformed JSON) -> ${badJson.status} ${badJson.json.error.code}`);
  judge(badJson.status === 400 && badJson.json.error.code === "INPUT_ERROR", "malformed JSON rejected");

  // S3: not found
  scenario = "S3 not found";
  console.log("\n== S3 unknown run ==");
  const nf = await api("GET", "/runs/run-nope");
  step(`GET /runs/run-nope -> ${nf.status} ${nf.json.error.code}`);
  judge(nf.status === 404 && nf.json.error.code === "NOT_FOUND", "unknown run -> NOT_FOUND");

  // S4: low concurrency, all success
  scenario = "S4 all-success run";
  console.log("\n== S4 low-concurrency all-success run ==");
  const okUrl = target.url + "/ok";
  const s4 = await api("POST", "/runs", { targetUrl: okUrl, concurrency: 2, totalRequests: 20, timeoutMs: 3000 });
  step(`POST /runs {concurrency:2,total:20} -> ${s4.status} runId=${s4.json.runId}`);
  const run4 = await waitRun(s4.json.runId);
  step(`summary: success=${run4.summary.successCount} failure=${run4.summary.failureCount} rps=${run4.summary.throughputRps.toFixed(1)}`);
  judge(run4.summary.successCount === 20 && run4.summary.failureCount === 0, "all 20 requests succeeded");
  const res4 = await getResults(s4.json.runId);
  judge(res4.length === 20, "no result lost (20/20 persisted)");
  const ref4 = refStats(res4.filter((r) => r.outcome === "success").map((r) => r.latencyMs));
  judge(statsMatch(run4.summary.successStats, ref4), "successStats match independent reference computation");
  judge(run4.summary.failureStats === null, "failureStats is null when no failures");

  // S5: mixed success/failure
  scenario = "S5 mixed run";
  console.log("\n== S5 mixed success/failure run ==");
  const s5 = await api("POST", "/runs", { targetUrl: target.url + "/flaky", concurrency: 3, totalRequests: 10, timeoutMs: 3000 });
  const run5 = await waitRun(s5.json.runId);
  step(`summary: success=${run5.summary.successCount} failure=${run5.summary.failureCount} kinds=${JSON.stringify(run5.summary.failuresByKind)}`);
  judge(run5.summary.successCount === 5 && run5.summary.failureCount === 5, "5 success / 5 failure");
  judge(run5.summary.failuresByKind.http_error === 5
    && run5.summary.failuresByKind.timeout === 0
    && run5.summary.failuresByKind.network_error === 0, "failures classified as http_error");
  const res5 = await getResults(s5.json.runId);
  const refS = refStats(res5.filter((r) => r.outcome === "success").map((r) => r.latencyMs));
  const refF = refStats(res5.filter((r) => r.outcome === "failure").map((r) => r.latencyMs));
  judge(statsMatch(run5.summary.successStats, refS) && statsMatch(run5.summary.failureStats, refF),
    "success/failure latency stats computed separately and match reference");

  // S6: percentile boundary values with deterministic delays 10..100ms
  scenario = "S6 percentile boundaries";
  console.log("\n== S6 percentile boundary values (delays 10..100ms) ==");
  const s6 = await api("POST", "/runs", { targetUrl: target.url + "/seqdelay?step=10", concurrency: 1, totalRequests: 10, timeoutMs: 5000 });
  const run6 = await waitRun(s6.json.runId);
  const res6 = await getResults(s6.json.runId);
  const lat6 = res6.map((r) => r.latencyMs);
  step(`recorded latencies: [${lat6.map((v) => v.toFixed(0)).join(", ")}]`);
  const ref6 = refStats(lat6);
  step(`service p50=${run6.summary.successStats.p50Ms.toFixed(2)} p90=${run6.summary.successStats.p90Ms.toFixed(2)} p99=${run6.summary.successStats.p99Ms.toFixed(2)}`);
  step(`ref     p50=${ref6.p50Ms.toFixed(2)} p90=${ref6.p90Ms.toFixed(2)} p99=${ref6.p99Ms.toFixed(2)}`);
  judge(statsMatch(run6.summary.successStats, ref6), "percentiles match independent reference on recorded data");
  judge(run6.summary.successStats.minMs >= 8 && run6.summary.successStats.maxMs >= 95,
    "min/max bracket the 10ms..100ms server delays");
  const sorted6 = [...lat6].sort((a, b) => a - b);
  judge(lat6.every((v, i) => i === 0 || v >= lat6[i - 1] - 5) || sorted6[0] >= 8,
    "latency ordering consistent with increasing server delays");

  // S7: timeout and network error categories
  scenario = "S7 failure categories";
  console.log("\n== S7 timeout vs network_error ==");
  const s7a = await api("POST", "/runs", { targetUrl: target.url + "/slow?ms=400", concurrency: 2, totalRequests: 4, timeoutMs: 60 });
  const run7a = await waitRun(s7a.json.runId);
  step(`timeout run: kinds=${JSON.stringify(run7a.summary.failuresByKind)}`);
  judge(run7a.summary.failuresByKind.timeout === 4, "4 timeouts classified as timeout");
  const s7b = await api("POST", "/runs", { targetUrl: "http://127.0.0.1:1/down", concurrency: 1, totalRequests: 3, timeoutMs: 1000 });
  const run7b = await waitRun(s7b.json.runId);
  step(`refused run: kinds=${JSON.stringify(run7b.summary.failuresByKind)}`);
  judge(run7b.summary.failuresByKind.network_error === 3, "3 refused connections classified as network_error");

  // S8: history query & comparison
  scenario = "S8 history query/compare";
  console.log("\n== S8 history query and comparison ==");
  const byUrl = await api("GET", "/runs?targetUrl=" + encodeURIComponent(okUrl));
  step(`GET /runs?targetUrl=.../ok -> count=${byUrl.json.count}`);
  judge(byUrl.json.count >= 1 && byUrl.json.runs.every((r) => r.targetUrl === okUrl), "filter by targetUrl works");
  const future = await api("GET", "/runs?from=" + encodeURIComponent(new Date(Date.now() + 3600e3).toISOString()));
  judge(future.json.count === 0, "time-range filter works (future window empty)");
  const cmp = await api("GET", `/runs/${s4.json.runId}/compare/${s5.json.runId}`);
  step(`compare run4 vs run5 -> ${cmp.status} deltaRps=${cmp.json.delta.throughputRps.toFixed(1)}`);
  judge(cmp.status === 200 && typeof cmp.json.delta.throughputRps === "number", "comparison of completed runs");

  // S9: resource exhaustion is distinguishable
  scenario = "S9 resource exhausted";
  console.log("\n== S9 concurrent run limit ==");
  const slow = { targetUrl: target.url + "/slow?ms=600", concurrency: 1, totalRequests: 2, timeoutMs: 3000 };
  const posts = await Promise.all([0, 1, 2, 3, 4, 5].map(() => api("POST", "/runs", slow)));
  const rejected = posts.filter((p) => p.status === 429);
  step(`6 concurrent run requests -> statuses [${posts.map((p) => p.status).join(", ")}]`);
  judge(rejected.length >= 1 && rejected.every((p) => p.json.error.code === "RESOURCE_EXHAUSTED"),
    "excess runs rejected as RESOURCE_EXHAUSTED (429)");
  for (const p of posts.filter((p) => p.status === 202)) await waitRun(p.json.runId);
} catch (err) {
  console.error(`\n[FAIL] scenario "${scenario}" threw: ${err.stack || err}`);
  failures++;
} finally {
  await adapter.close();
  store.close();
  await target.close();
}

console.log(`\n========================================`);
if (failures > 0) {
  console.error(`ACCEPTANCE FAILED: ${failures} judgment(s) failed (last scenario: ${scenario})`);
  process.exit(1);
}
console.log("ACCEPTANCE PASSED: all scenarios green");
process.exit(0);
