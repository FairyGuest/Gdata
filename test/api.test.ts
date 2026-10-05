import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type RunningApp } from "../src/server/app.ts";

let app: RunningApp;
let base: string;

before(async () => {
  app = await buildApp({ port: 0, dbPath: ":memory:", logFile: undefined });
  await app.adapter.listen(0, "127.0.0.1");
  base = "http://127.0.0.1:" + app.adapter.port();
});

after(async () => {
  await app.close();
});

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() } as { status: number; body: any };
}

test("full lifecycle over HTTP: create, pass, fail with diffs, ignore, update", async () => {
  const create = await post("/snapshots/compare", { name: "api-1", data: { user: { address: { city: "Beijing" } }, tags: ["a", "b"] } });
  assert.equal(create.status, 200);
  assert.equal(create.body.status, "created");
  assert.ok(create.body.runId);

  const pass = await post("/snapshots/compare", { name: "api-1", data: { user: { address: { city: "Beijing" } }, tags: ["a", "b"] } });
  assert.equal(pass.body.status, "passed");

  const fail = await post("/snapshots/compare", { name: "api-1", data: { user: { address: { city: "Shanghai" } }, tags: ["a", "b", "c"] } });
  assert.equal(fail.body.status, "failed");
  assert.deepEqual(fail.body.diffs, [
    { path: "user.address.city", type: "modified", before: "Beijing", after: "Shanghai" },
    { path: "tags[2]", type: "added", after: "c" },
  ]);

  const ignored = await post("/snapshots/compare", { name: "api-1", data: { user: { address: { city: "Shanghai" } }, tags: ["a", "b", "c"] }, ignorePaths: ["user.address.city", "tags[2]"] });
  assert.equal(ignored.body.status, "passed");

  const upd = await post("/snapshots/compare", { name: "api-1", data: { user: { address: { city: "Shanghai" } }, tags: ["a", "b", "c"] }, update: true });
  assert.equal(upd.body.status, "updated");
});

test("input error category is distinguishable (400 INPUT_ERROR)", async () => {
  const res = await post("/snapshots/compare", { data: { a: 1 } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.category, "INPUT_ERROR");
  assert.equal(res.body.error.code, "INVALID_NAME");
});

test("malformed JSON yields INPUT_ERROR/INVALID_JSON", async () => {
  const res = await fetch(base + "/snapshots/compare", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.equal(body.error.category, "INPUT_ERROR");
  assert.equal(body.error.code, "INVALID_JSON");
});

test("state conflict on duplicate explicit create (409 STATE_CONFLICT)", async () => {
  await post("/snapshots/create", { name: "api-dup", data: 1 });
  const res = await post("/snapshots/create", { name: "api-dup", data: 2 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.category, "STATE_CONFLICT");
  assert.equal(res.body.error.code, "SNAPSHOT_EXISTS");
});

test("missing snapshot get yields 409 SNAPSHOT_NOT_FOUND", async () => {
  const res = await fetch(base + "/snapshots/does-not-exist");
  assert.equal(res.status, 409);
  const body = await res.json() as any;
  assert.equal(body.error.code, "SNAPSHOT_NOT_FOUND");
});
