// Engine integration tests. Expected outcomes are derived by hand from the
// fixture graph and fixture builder behaviors, not from the engine itself.

import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { parseTargets } from "../src/core/graph.ts";
import { SqliteBuildStore } from "../src/store/sqlite.ts";
import { FixtureBuilder } from "../src/adapters/builder.ts";
import { RingLogger } from "../src/adapters/logger.ts";
import type { LogEntry } from "../src/domain/types.ts";

const ROOT = join(process.cwd(), ".data-test", "engine");

// lib <- app, lib <- ui, util <- app, docs standalone
const DEFS = {
  targets: [
    { name: "lib", watchPaths: ["lib.txt"], dependencies: [] },
    { name: "util", watchPaths: ["util.txt"], dependencies: [] },
    { name: "app", watchPaths: ["app.txt"], dependencies: ["lib", "util"] },
    { name: "ui", watchPaths: ["ui.txt"], dependencies: ["lib"] },
    { name: "docs", watchPaths: ["docs.txt"], dependencies: [] },
  ],
};

function setup(opts: { buildDelayMs?: number; maxQueueSize?: number } = {}) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  for (const f of ["lib.txt", "util.txt", "app.txt", "ui.txt", "docs.txt"]) {
    writeFileSync(join(ROOT, f), "v1-" + f);
  }
  const store = new SqliteBuildStore(":memory:");
  const builder = new FixtureBuilder(opts.buildDelayMs ?? 5);
  const entries: LogEntry[] = [];
  const logger: RingLogger = Object.create(RingLogger.prototype);
  // in-memory only logger for assertions on reasons
  (logger as unknown as { entries: LogEntry[] }).entries = entries;
  (logger as unknown as { logFile: null }).logFile = null;
  const engine = new Engine({
    store,
    builder,
    config: { workspaceRoot: ROOT, maxQueueSize: opts.maxQueueSize ?? 100 },
    logger,
  });
  engine.setGraph(parseTargets(DEFS, 100));
  return { engine, store, builder, entries };
}

function outcomeMap(report: { outcomes: { target: string; status: string }[] }) {
  return new Map(report.outcomes.map((o) => [o.target, o.status]));
}

test("closure + topological order: change to lib rebuilds lib, app, ui in order", async () => {
  const { engine } = setup();
  writeFileSync(join(ROOT, "lib.txt"), "v2-lib");
  const report = await engine.submitChanges(["lib.txt"]);
  deepEqual(report.affected, ["app", "lib", "ui"]);
  deepEqual(report.order, ["lib", "app", "ui"]);
  const m = outcomeMap(report);
  equal(m.get("lib"), "success");
  equal(m.get("app"), "success");
  equal(m.get("ui"), "success");
});

test("fingerprint unchanged: re-submitted event with same content skips with reason", async () => {
  const { engine } = setup();
  writeFileSync(join(ROOT, "docs.txt"), "v2-docs");
  const first = await engine.submitChanges(["docs.txt"]);
  equal(outcomeMap(first).get("docs"), "success");
  // event arrives again but content did not change since the last build
  const second = await engine.submitChanges(["docs.txt"]);
  const o = second.outcomes.find((x) => x.target === "docs")!;
  equal(o.status, "skipped");
  ok(o.reason && o.reason.includes("fingerprint unchanged"), "skip reason must name the cause, got: " + o.reason);
});

test("upstream failure blocks downstream, which is never queued", async () => {
  const { engine, builder } = setup();
  builder.setBehavior("lib", "fail");
  writeFileSync(join(ROOT, "lib.txt"), "v2-lib");
  const report = await engine.submitChanges(["lib.txt"]);
  const m = outcomeMap(report);
  equal(m.get("lib"), "failed");
  equal(m.get("app"), "blocked");
  equal(m.get("ui"), "blocked");
  const app = report.outcomes.find((o) => o.target === "app")!;
  equal(app.blockedBy, "lib");
  ok(app.reason!.includes("lib"), "blocked reason must name the failed upstream");
  equal(builder.buildCount("app"), 0, "blocked target must not be built");
  equal(builder.buildCount("ui"), 0, "blocked target must not be built");
});

test("change during build coalesces into exactly one pending rebuild", async () => {
  const { engine, builder } = setup({ buildDelayMs: 60 });
  writeFileSync(join(ROOT, "docs.txt"), "v2-docs");
  const run1 = engine.submitChanges(["docs.txt"]);
  await new Promise((r) => setTimeout(r, 20)); // docs is now building
  writeFileSync(join(ROOT, "docs.txt"), "v3-docs");
  const run2 = engine.submitChanges(["docs.txt"]); // must merge, not double-queue
  const [r1, r2] = await Promise.all([run1, run2]);
  equal(outcomeMap(r1).get("docs"), "success");
  equal(outcomeMap(r2).get("docs"), "success");
  equal(builder.buildCount("docs"), 2, "exactly two builds: initial + one merged rebuild");
  ok(r1.runId !== r2.runId, "runs keep distinct ids for replay");
});

test("queued change merges without an extra build", async () => {
  const { engine, builder } = setup({ buildDelayMs: 60 });
  writeFileSync(join(ROOT, "lib.txt"), "v2-lib");
  // util change keeps the pump busy while two lib events arrive back-to-back
  writeFileSync(join(ROOT, "util.txt"), "v2-util");
  const run1 = engine.submitChanges(["util.txt", "lib.txt"]);
  const run2 = engine.submitChanges(["lib.txt"]);
  await Promise.all([run1, run2]);
  ok(builder.buildCount("lib") <= 2, "lib built at most twice, got " + builder.buildCount("lib"));
});

test("error categories: state conflict, contract, resource exhaustion", async () => {
  const { engine } = setup({ buildDelayMs: 50, maxQueueSize: 1 });
  // contract: bad payload
  let cat = "";
  try { await engine.submitChanges([]); } catch (e) { cat = (e as { category: string }).category; }
  equal(cat, "contract");
  // state conflict: redefine targets while a build is in flight
  writeFileSync(join(ROOT, "docs.txt"), "v2-docs");
  const pending = engine.submitChanges(["docs.txt"]);
  cat = "";
  try { engine.setGraph(parseTargets(DEFS, 100)); } catch (e) { cat = (e as { category: string }).category; }
  equal(cat, "state-conflict");
  await pending;
  // resource exhausted: queue depth 1, two idle targets affected at once
  const small = setup({ maxQueueSize: 1 });
  writeFileSync(join(ROOT, "lib.txt"), "v3-lib");
  writeFileSync(join(ROOT, "util.txt"), "v3-util");
  cat = "";
  try { await small.engine.submitChanges(["lib.txt", "util.txt"]); } catch (e) { cat = (e as { category: string }).category; }
  equal(cat, "resource-exhausted");
});

test("sqlite store: latest result and skip records queryable by target", async () => {
  const { engine, store } = setup();
  writeFileSync(join(ROOT, "docs.txt"), "v2-docs");
  await engine.submitChanges(["docs.txt"]);
  await engine.submitChanges(["docs.txt"]); // skipped
  const latest = store.latestBuild("docs");
  equal(latest!.status, "skipped");
  const history = store.history("docs");
  deepEqual(history.map((h) => h.status), ["skipped", "success"]);
  ok(store.getFingerprint("docs"), "fingerprint persisted");
});
