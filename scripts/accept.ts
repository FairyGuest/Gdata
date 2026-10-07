// One-shot acceptance script: exercises every required scenario in a fixed
// order against the real HTTP interface (in-process Fastify inject).
// Prints request / response / verdict per step. Exit 0 = all passed,
// non-zero = at least one scenario failed (the failing scenario is named).

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/http/server.ts";
import { Engine } from "../src/core/engine.ts";
import { SqliteBuildStore } from "../src/store/sqlite.ts";
import { FixtureBuilder } from "../src/adapters/builder.ts";
import { RingLogger } from "../src/adapters/logger.ts";
import { loadConfig } from "../src/config.ts";

const DATA = join(process.cwd(), ".data-accept");
const WORKSPACE = join(DATA, "workspace");
rmSync(DATA, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });

const config = loadConfig({ DATA_DIR: DATA, WORKSPACE_ROOT: WORKSPACE, BUILD_DELAY_MS: "80", DB_PATH: join(DATA, "builds.db"), LOG_FILE: join(DATA, "engine.log") });
const store = new SqliteBuildStore(config.dbPath);
const builder = new FixtureBuilder(config.buildDelayMs);
const logger = new RingLogger(config.logFile);
const engine = new Engine({ store, builder, config: { workspaceRoot: WORKSPACE, maxQueueSize: config.maxQueueSize }, logger });
const app = buildServer({ engine, store, logger, config });

const targets = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "targets.json"), "utf8"));
for (const t of targets.targets) {
  for (const p of t.watchPaths) writeFileSync(join(WORKSPACE, p), "v1 of " + p);
}

let failures = 0;

function verdict(name: string, ok: boolean, detail: string): void {
  console.log("  verdict: " + (ok ? "PASS" : "FAIL") + " - " + detail);
  if (!ok) failures++;
}

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() };
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log("\n[" + name + "]");
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log("  verdict: FAIL - unexpected error: " + (err as Error).message);
  }
}

await scenario("S1 register targets", async () => {
  const r = await post("/targets", targets);
  console.log("  response: " + JSON.stringify(r.body));
  verdict("S1", r.status === 200 && r.body.registered.length === 5, "5 targets registered");
});

await scenario("S2 closure + topological order", async () => {
  writeFileSync(join(WORKSPACE, "lib.txt"), "v2 of lib.txt");
  console.log("  request: POST /events {paths:[lib.txt]}");
  const r = await post("/events", { paths: ["lib.txt"] });
  console.log("  response: affected=" + JSON.stringify(r.body.affected) + " order=" + JSON.stringify(r.body.order));
  const ok = r.status === 200
    && JSON.stringify(r.body.affected) === JSON.stringify(["app", "lib", "ui"])
    && JSON.stringify(r.body.order) === JSON.stringify(["lib", "app", "ui"])
    && r.body.outcomes.every((o: { status: string }) => o.status === "success");
  verdict("S2", ok, "closure {app,lib,ui}, order [lib,app,ui], all success");
});

await scenario("S3 fingerprint unchanged -> skipped with reason", async () => {
  console.log("  request: POST /events {paths:[lib.txt]} (content untouched)");
  const r = await post("/events", { paths: ["lib.txt"] });
  const lib = r.body.outcomes.find((o: { target: string }) => o.target === "lib");
  console.log("  response: lib=" + JSON.stringify(lib));
  verdict("S3", lib.status === "skipped" && typeof lib.reason === "string" && lib.reason.includes("fingerprint unchanged"), "lib skipped, reason names fingerprint");
});

await scenario("S4 upstream failure blocks downstream", async () => {
  builder.setBehavior("util", "fail");
  writeFileSync(join(WORKSPACE, "util.txt"), "v2 of util.txt");
  console.log("  request: POST /events {paths:[util.txt]} (util fixture = fail)");
  const r = await post("/events", { paths: ["util.txt"] });
  builder.setBehavior("util", "success");
  const m = new Map(r.body.outcomes.map((o: { target: string; status: string }) => [o.target, o.status]));
  const app_ = r.body.outcomes.find((o: { target: string }) => o.target === "app");
  console.log("  response: util=" + m.get("util") + " app=" + m.get("app") + " blockedBy=" + app_.blockedBy);
  const ok = m.get("util") === "failed" && m.get("app") === "blocked" && app_.blockedBy === "util" && builder.buildCount("app") === 1;
  verdict("S4", ok, "util failed, app blocked by util, app not re-built (count still 1)");
});

await scenario("S5 mid-build change coalesces into one pending rebuild", async () => {
  writeFileSync(join(WORKSPACE, "docs.txt"), "v2 of docs.txt");
  const before = builder.buildCount("docs");
  const r1 = post("/events", { paths: ["docs.txt"] });
  await new Promise((res) => setTimeout(res, 30)); // docs is building now
  writeFileSync(join(WORKSPACE, "docs.txt"), "v3 of docs.txt");
  const r2 = post("/events", { paths: ["docs.txt"] });
  const [a, b] = await Promise.all([r1, r2]);
  const builds = builder.buildCount("docs") - before;
  console.log("  response: run1=" + a.body.runId + " run2=" + b.body.runId + " docs builds this scenario=" + builds);
  verdict("S5", builds === 2 && a.body.outcomes[0].status === "success" && b.body.outcomes[0].status === "success", "exactly one merged rebuild, both runs settled");
});

await scenario("S6 error semantics are distinguishable", async () => {
  const badPayload = await post("/events", { paths: "oops" });
  const badTargets = await post("/targets", { targets: [] });
  const notFoundRes = await app.inject({ method: "GET", url: "/runs/run-9999" });
  console.log("  responses: events=" + badPayload.status + "/" + badPayload.body.error.category
    + " targets=" + badTargets.status + "/" + badTargets.body.error.category
    + " run=" + notFoundRes.statusCode + "/" + notFoundRes.json().error.category);
  const ok = badPayload.status === 400 && badPayload.body.error.category === "contract"
    && badTargets.status === 400 && notFoundRes.statusCode === 404 && notFoundRes.json().error.category === "not-found";
  verdict("S6", ok, "contract=400, not-found=404, distinct categories");
});

await scenario("S7 SQLite: latest result + skip records by target", async () => {
  const r = await app.inject({ method: "GET", url: "/targets/lib/history" });
  const statuses = r.json().history.map((h: { status: string }) => h.status);
  console.log("  response: lib history=" + JSON.stringify(statuses));
  const ok = statuses.includes("success") && statuses.includes("skipped") && store.getFingerprint("lib") !== null;
  verdict("S7", ok, "history contains success + skipped, fingerprint persisted");
});

await app.close();
store.close();

console.log("\n========================================");
if (failures > 0) {
  console.log("ACCEPTANCE FAILED: " + failures + " scenario(s) failed");
  process.exit(1);
}
console.log("ACCEPTANCE PASSED: all 7 scenarios green");
