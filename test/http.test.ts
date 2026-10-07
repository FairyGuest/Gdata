// HTTP contract tests (Fastify inject, no real port). Verifies the diagnostic
// interface and that error categories map to distinct HTTP statuses.

import { test, before, after } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/http/server.ts";
import { Engine } from "../src/core/engine.ts";
import { SqliteBuildStore } from "../src/store/sqlite.ts";
import { FixtureBuilder } from "../src/adapters/builder.ts";
import { RingLogger } from "../src/adapters/logger.ts";
import { loadConfig } from "../src/config.ts";

const ROOT = join(process.cwd(), ".data-test", "http");

let app: FastifyInstance;
let store: SqliteBuildStore;

const TARGETS = {
  targets: [
    { name: "lib", watchPaths: ["lib.txt"], dependencies: [] },
    { name: "app", watchPaths: ["app.txt"], dependencies: ["lib"] },
  ],
};

before(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "lib.txt"), "lib-v1");
  writeFileSync(join(ROOT, "app.txt"), "app-v1");
  const config = loadConfig({ DATA_DIR: ROOT, WORKSPACE_ROOT: ROOT, BUILD_DELAY_MS: "1" });
  store = new SqliteBuildStore(":memory:");
  const logger = new RingLogger(null);
  const engine = new Engine({
    store,
    builder: new FixtureBuilder(1),
    config: { workspaceRoot: ROOT, maxQueueSize: 100 },
    logger,
  });
  app = buildServer({ engine, store, logger, config });
});

after(async () => {
  await app.close();
  store.close();
  rmSync(ROOT, { recursive: true, force: true });
});

test("events before targets are registered -> 409 state-conflict", async () => {
  const res = await app.inject({ method: "POST", url: "/events", payload: { paths: ["lib.txt"] } });
  equal(res.statusCode, 409);
  equal(res.json().error.category, "state-conflict");
});

test("invalid target contract -> 400 contract", async () => {
  const res = await app.inject({ method: "POST", url: "/targets", payload: { targets: [{ name: "x" }] } });
  equal(res.statusCode, 400);
  equal(res.json().error.category, "contract");
});

test("register, build, query latest + history + logs", async () => {
  let res = await app.inject({ method: "POST", url: "/targets", payload: TARGETS });
  equal(res.statusCode, 200);
  equal(res.json().registered.join(","), "app,lib");

  writeFileSync(join(ROOT, "lib.txt"), "lib-v2");
  res = await app.inject({ method: "POST", url: "/events", payload: { paths: ["lib.txt"] } });
  equal(res.statusCode, 200);
  const report = res.json();
  equal(report.order.join(","), "lib,app");
  ok(report.runId.startsWith("run-"), "run id present for replay: " + report.runId);

  res = await app.inject({ method: "GET", url: "/targets/lib" });
  equal(res.json().latest.status, "success");
  ok(res.json().fingerprint, "fingerprint exposed");

  // skip path: same content again
  res = await app.inject({ method: "POST", url: "/events", payload: { paths: ["lib.txt"] } });
  equal(res.json().outcomes.find((o: { target: string }) => o.target === "lib").status, "skipped");

  res = await app.inject({ method: "GET", url: "/targets/lib/history" });
  const statuses = res.json().history.map((h: { status: string }) => h.status);
  ok(statuses.includes("skipped") && statuses.includes("success"), "history keeps skip records: " + statuses);

  res = await app.inject({ method: "GET", url: "/logs", query: { runId: report.runId } });
  ok(res.json().entries.length > 0, "diagnostic log queryable by runId");
});

test("unknown run -> 404 not-found", async () => {
  const res = await app.inject({ method: "GET", url: "/runs/run-9999" });
  equal(res.statusCode, 404);
  equal(res.json().error.category, "not-found");
});

test("malformed event payload -> 400 contract, never silent success", async () => {
  const res = await app.inject({ method: "POST", url: "/events", payload: { paths: "lib.txt" } });
  equal(res.statusCode, 400);
  equal(res.json().error.category, "contract");
});
