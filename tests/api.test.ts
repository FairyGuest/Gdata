import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RunStore } from "../src/state/store.ts";
import { DriftService } from "../src/core/service.ts";
import { buildRouter } from "../src/server/app.ts";
import { createNodeHttpAdapter } from "../src/server/http.ts";
import type { AppAdapter } from "../src/server/http.ts";

let adapter: AppAdapter;
let base: string;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

before(async () => {
  const service = new DriftService(new RunStore(":memory:"), { info() {} });
  adapter = createNodeHttpAdapter(buildRouter(service));
  const { port } = await adapter.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

after(async () => adapter.close());

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("POST /v1/drift-checks happy path and replay over HTTP", async () => {
  const input = {
    env: "staging",
    layers: { base: fixture("base.json"), env: fixture("env.staging.json"), instance: fixture("instance.json") },
    snapshot: fixture("snapshot.drifting.json"),
  };
  const created = await post("/v1/drift-checks", input);
  assert.equal(created.status, 200);
  assert.equal(created.body.report.status, "DRIFT");
  const replay = await fetch(`${base}/v1/runs/${created.body.runId}?env=staging`);
  assert.equal(replay.status, 200);
  const record = await replay.json();
  assert.equal(record.report.status, "DRIFT");
});

test("HTTP error mapping: 400 input, 404 missing, 409 conflict", async () => {
  const bad = await post("/v1/drift-checks", { env: "x", layers: { base: {}, env: {}, instance: {} } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.category, "INPUT_ERROR");

  const missing = await fetch(`${base}/v1/runs/nope`);
  assert.equal(missing.status, 404);

  const ok = await post("/v1/drift-checks", {
    env: "staging",
    layers: { base: {}, env: {}, instance: {} },
    snapshot: {},
  });
  const conflict = await fetch(`${base}/v1/runs/${ok.body.runId}?env=other`);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.category, "STATE_CONFLICT");
});

test("invalid JSON body maps to 400 INPUT_ERROR", async () => {
  const res = await fetch(base + "/v1/drift-checks", { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.category, "INPUT_ERROR");
});
