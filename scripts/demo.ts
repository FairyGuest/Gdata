// Local demo: drives the service in-process (Fastify inject, no port needed)
// through the four core scenarios and prints every step.

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/http/server.ts";
import { Engine } from "../src/core/engine.ts";
import { SqliteBuildStore } from "../src/store/sqlite.ts";
import { FixtureBuilder } from "../src/adapters/builder.ts";
import { RingLogger } from "../src/adapters/logger.ts";
import { loadConfig } from "../src/config.ts";

const DATA = join(process.cwd(), ".data-demo");
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

async function step(title: string, fn: () => Promise<unknown>): Promise<void> {
  console.log("\n=== " + title + " ===");
  const out = await fn();
  console.log(JSON.stringify(out, null, 2));
}

await step("POST /targets (register fixture graph)", async () =>
  (await app.inject({ method: "POST", url: "/targets", payload: targets })).json());

writeFileSync(join(WORKSPACE, "lib.txt"), "v2 of lib.txt");
await step("POST /events [lib.txt] -> closure {lib,app,ui}, topo order", async () =>
  (await app.inject({ method: "POST", url: "/events", payload: { paths: ["lib.txt"] } })).json());

await step("POST /events [lib.txt] again -> fingerprint unchanged, skipped", async () =>
  (await app.inject({ method: "POST", url: "/events", payload: { paths: ["lib.txt"] } })).json());

builder.setBehavior("util", "fail");
writeFileSync(join(WORKSPACE, "util.txt"), "v2 of util.txt");
await step("POST /events [util.txt] -> util fails, app blocked", async () =>
  (await app.inject({ method: "POST", url: "/events", payload: { paths: ["util.txt"] } })).json());
builder.setBehavior("util", "success");

writeFileSync(join(WORKSPACE, "docs.txt"), "v2 of docs.txt");
const run1 = app.inject({ method: "POST", url: "/events", payload: { paths: ["docs.txt"] } });
await new Promise((r) => setTimeout(r, 30));
writeFileSync(join(WORKSPACE, "docs.txt"), "v3 of docs.txt");
const run2 = app.inject({ method: "POST", url: "/events", payload: { paths: ["docs.txt"] } });
await step("two POST /events [docs.txt] mid-build -> coalesced into one extra build", async () => {
  const [r1, r2] = await Promise.all([run1, run2]);
  return { run1: r1.json().outcomes, run2: r2.json().outcomes, actualBuilds: builder.buildCount("docs") };
});

await step("GET /targets/docs/history (SQLite: latest + skip records)", async () =>
  (await app.inject({ method: "GET", url: "/targets/docs/history" })).json());

await app.close();
store.close();
console.log("\ndemo finished. logs at " + config.logFile);
