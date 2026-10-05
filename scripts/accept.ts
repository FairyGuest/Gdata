/**
 * One-shot acceptance script: boots the service on an ephemeral port with a
 * temp database, then walks every required scenario in a fixed order,
 * printing request, response and verdict for each step.
 * Exit code 0 = all scenarios passed; 1 = at least one failed.
 */
import { loadConfig } from "../src/config.ts";
import { ResultStore } from "../src/store/db.ts";
import { buildApp } from "../src/server/app.ts";

const cfg = loadConfig(undefined, { ...process.env, TEST_RUNNER_DB: ":memory:" });
cfg.dbPath = ":memory:";
const store = new ResultStore(":memory:");
const app = buildApp(cfg, store);

let failures = 0;
let stepNo = 0;

function verdict(name: string, ok: boolean, detail: string): void {
  stepNo++;
  const mark = ok ? "PASS" : "FAIL";
  console.log("  [" + mark + "] step " + stepNo + " " + name + " - " + detail);
  if (!ok) failures++;
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const res = await fetch("http://127.0.0.1:" + port + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  console.log("  > " + method + " " + path + (body ? " body=" + JSON.stringify(body) : ""));
  console.log("  < " + res.status + " " + JSON.stringify(json).slice(0, 400));
  return { status: res.status, json };
}

interface RunSummaryJson {
  runId: string;
  total: number;
  passed: number;
  failed: number;
  timeout: number;
  results: Array<{ caseId: string; file: string; status: string; durationMs: number; error?: { message: string } }>;
}

const main = async (): Promise<void> => {
  await app.listen({ host: "127.0.0.1", port: 0 });

  console.log("\n== Scenario 1: health check ==");
  const health = await req("GET", "/health");
  verdict("health", health.status === 200 && (health.json as { status: string }).status === "ok", "service is up");

  console.log("\n== Scenario 2: passing tests ==");
  const pass = await req("POST", "/runs", { dir: "demo/pass", timeoutMs: 2000 });
  const passRun = pass.json as RunSummaryJson;
  verdict(
    "all passed",
    pass.status === 201 && passRun.total === 2 && passRun.passed === 2 && passRun.failed === 0 && passRun.timeout === 0,
    "total=" + passRun.total + " passed=" + passRun.passed,
  );

  console.log("\n== Scenario 3: assertion failure is reported with error info ==");
  const fail = await req("POST", "/runs", { dir: "demo/fail", timeoutMs: 2000 });
  const failRun = fail.json as RunSummaryJson;
  const failedCase = failRun.results.find((r) => r.status === "failed");
  verdict(
    "failure classified",
    failRun.passed === 1 && failRun.failed === 1 && !!failedCase?.error?.message.includes("arithmetic is broken on purpose"),
    "failed case: " + (failedCase?.caseId ?? "none") + " error=" + (failedCase?.error?.message ?? "none"),
  );

  console.log("\n== Scenario 4: hanging case is terminated, siblings unaffected ==");
  const t0 = Date.now();
  const to = await req("POST", "/runs", { dir: "demo/timeout", timeoutMs: 500 });
  const elapsed = Date.now() - t0;
  const toRun = to.json as RunSummaryJson;
  const hung = toRun.results.find((r) => r.status === "timeout");
  const quick = toRun.results.find((r) => r.caseId.includes("quick case still runs"));
  verdict(
    "timeout classified",
    toRun.timeout === 1 && !!hung && hung.durationMs >= 450 && quick?.status === "passed" && elapsed < 5000,
    "hung=" + (hung?.caseId ?? "none") + " durationMs=" + (hung?.durationMs ?? "?") +
      " quick=" + (quick?.status ?? "?") + " wall=" + elapsed + "ms",
  );

  console.log("\n== Scenario 5: parallel files do not interfere ==");
  const par = await req("POST", "/runs", { dir: "demo/parallel", parallel: 2, timeoutMs: 3000 });
  const parRun = par.json as RunSummaryJson;
  verdict(
    "parallel isolation",
    parRun.total === 2 && parRun.passed === 2,
    "total=" + parRun.total + " passed=" + parRun.passed,
  );

  console.log("\n== Scenario 6: dependency order is respected ==");
  const ord = await req("POST", "/runs", { dir: "demo/ordered", parallel: 2, timeoutMs: 3000 });
  const ordRun = ord.json as RunSummaryJson;
  verdict(
    "ordered execution",
    ordRun.total === 2 && ordRun.passed === 2,
    "dep-b consumed dep-a output successfully",
  );

  console.log("\n== Scenario 7: history query by run id and by file ==");
  const byId = await req("GET", "/runs/" + passRun.runId);
  const byFile = await req("GET", "/runs?file=" + encodeURIComponent("logic.test.js"));
  const byFileRuns = (byFile.json as { runs: RunSummaryJson[] }).runs;
  verdict(
    "history query",
    byId.status === 200 && (byId.json as RunSummaryJson).runId === passRun.runId &&
      byFileRuns.length >= 1 && byFileRuns.every((r) => r.results.some((c) => c.file === "logic.test.js")),
    "runId lookup ok, file query returned " + byFileRuns.length + " run(s)",
  );

  console.log("\n== Scenario 8: error semantics are distinguishable ==");
  const badDir = await req("POST", "/runs", { dir: "demo/no-such-dir" });
  verdict("input error", badDir.status === 400 && (badDir.json as { error: { code: string } }).error.code === "INPUT_ERROR",
    "status=" + badDir.status);
  const tooBig = await req("POST", "/runs", { dir: "demo/pass", parallel: 999 });
  verdict("resource exhausted", tooBig.status === 503 && (tooBig.json as { error: { code: string } }).error.code === "RESOURCE_EXHAUSTED",
    "status=" + tooBig.status);
  const missing = await req("GET", "/runs/00000000-0000-0000-0000-000000000000");
  verdict("not found", missing.status === 404 && (missing.json as { error: { code: string } }).error.code === "NOT_FOUND",
    "status=" + missing.status);

  await app.close();
  store.close();
  console.log("\n== Result: " + (failures === 0 ? "ALL " + stepNo + " CHECKS PASSED" : failures + " of " + stepNo + " checks FAILED") + " ==");
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("accept script crashed:", err);
  process.exit(1);
});
