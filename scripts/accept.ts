// One-key acceptance: boots the service on an ephemeral port with a
// throwaway SQLite file, then drills every acceptance scenario in a fixed
// order, printing request, response and verdict for each. Exit 0 iff all pass.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/state/store.ts";
import { DriftService } from "../src/core/service.ts";
import { buildRouter } from "../src/server/app.ts";
import { createNodeHttpAdapter } from "../src/server/http.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const tmp = mkdtempSync(join(tmpdir(), "env-drift-accept-"));
const service = new DriftService(new RunStore(join(tmp, "accept.db")), { info() {} });
const adapter = createNodeHttpAdapter(buildRouter(service));
const { port } = await adapter.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${port}`;

let failures = 0;
let step = 0;

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  step += 1;
  console.log(`\n=== [${step}] ${name} ===`);
  try {
    await fn();
    console.log(`VERDICT: PASS -- ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`VERDICT: FAIL -- ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expect(cond: boolean, why: string): void {
  if (!cond) throw new Error(`assertion failed: ${why}`);
}

function show(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

const driftInput = {
  env: "staging",
  layers: { base: fixture("base.json"), env: fixture("env.staging.json"), instance: fixture("instance.json") },
  snapshot: fixture("snapshot.drifting.json"),
};
const cleanInput = { ...driftInput, snapshot: fixture("snapshot.clean.json") };
let driftRunId = "";

await scenario("deep merge / array replace / null delete via effective config", async () => {
  show("request", { method: "POST", path: "/v1/drift-checks", body: driftInput });
  const res = await request("POST", "/v1/drift-checks", driftInput);
  show("response", res);
  expect(res.status === 200, "status 200");
  const eff = res.body.merge.effective;
  expect(eff.http.timeouts.readMs === 8000 && eff.http.timeouts.writeMs === 5000, "deep merge keeps writeMs, overrides readMs");
  expect(eff.http.port === 9090, "instance layer overrides port");
  expect(JSON.stringify(eff.tags) === '["core","billing","staging"]', "array replaced wholesale");
  expect(!("legacyExport" in eff.features), "null deleted legacyExport");
  expect(eff.features.betaUI === true, "instance patch flipped betaUI");
  driftRunId = res.body.runId;
});

await scenario("drift classification: three kinds with dot paths and severity order", async () => {
  const res = await request("POST", "/v1/drift-checks", driftInput);
  show("response.report", res.body.report);
  const got = res.body.report.drifts.map((d: { kind: string; path: string }) => [d.kind, d.path]);
  const want = [
    ["missing_required", "http.timeouts.writeMs"],
    ["value_mismatch", "service.replicas"],
    ["extra_in_snapshot", "runtimeOnly"],
  ];
  expect(JSON.stringify(got) === JSON.stringify(want), `drift list ${JSON.stringify(got)} == ${JSON.stringify(want)}`);
  expect(res.body.report.status === "DRIFT", "status DRIFT");
});

await scenario("no drift yields explicit PASS marker", async () => {
  show("request", { method: "POST", path: "/v1/drift-checks", body: cleanInput });
  const res = await request("POST", "/v1/drift-checks", cleanInput);
  show("response.report", res.body.report);
  expect(res.body.report.status === "PASS", "status PASS");
  expect(res.body.report.drifts.length === 0, "empty drift list");
});

await scenario("invalid layer structure rejected with layer name and position", async () => {
  const bad = { env: "staging", layers: { base: {}, env: { outer: { "": 1 } }, instance: {} }, snapshot: {} };
  show("request", { method: "POST", path: "/v1/drift-checks", body: bad });
  const res = await request("POST", "/v1/drift-checks", bad);
  show("response", res);
  expect(res.status === 400, "status 400");
  expect(res.body.error.category === "INPUT_ERROR", "category INPUT_ERROR");
  expect(res.body.error.detail.layer === "env" && res.body.error.detail.path === "outer", "layer=env path=outer");
  const bad2 = { env: "staging", layers: { base: [1], env: {}, instance: {} }, snapshot: {} };
  const res2 = await request("POST", "/v1/drift-checks", bad2);
  show("response (non-object layer)", res2);
  expect(res2.status === 400 && res2.body.error.detail.layer === "base", "non-object base layer rejected");
});

await scenario("runs persisted and replayable by env name", async () => {
  const list = await request("GET", "/v1/runs?env=staging");
  show("response (run list)", list.body.runs.map((r: { runId: string; status: string }) => r));
  expect(list.body.runs.some((r: { runId: string }) => r.runId === driftRunId), "drift run listed for env=staging");
  const replay = await request("GET", `/v1/runs/${driftRunId}?env=staging`);
  show("response (replay)", { runId: replay.body.runId, status: replay.body.report.status, drifts: replay.body.report.drifts.length });
  expect(replay.body.report.status === "DRIFT", "replayed report is DRIFT");
  expect(replay.body.input.layers.base !== undefined, "replayed record carries original layers");
});

await scenario("error taxonomy: 404 unknown run, 409 env conflict", async () => {
  const missing = await request("GET", "/v1/runs/does-not-exist");
  show("response (unknown run)", missing);
  expect(missing.status === 404 && missing.body.error.category === "NOT_FOUND", "404 NOT_FOUND");
  const conflict = await request("GET", `/v1/runs/${driftRunId}?env=production`);
  show("response (env conflict)", conflict);
  expect(conflict.status === 409 && conflict.body.error.category === "STATE_CONFLICT", "409 STATE_CONFLICT");
});

await adapter.close();
service.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

console.log(`\n========================================`);
console.log(failures === 0 ? `ACCEPTANCE: ALL ${step} SCENARIOS PASSED` : `ACCEPTANCE: ${failures}/${step} SCENARIOS FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
