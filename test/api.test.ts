import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SnapshotEngine } from "../src/core/engine.ts";
import { SqliteSnapshotStore } from "../src/store/sqlite.ts";
import { createHttpServer } from "../src/http/server.ts";

let server: Server;
let base: string;

before(async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const engine = new SnapshotEngine(store, {
    maxDiffEntries: 100,
    maxSerializedBytes: 10_000,
  });
  server = createHttpServer(engine, { maxPayloadBytes: 2048 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = "http://127.0.0.1:" + addr.port;
});

after(() => server.close());

async function post(path: string, body: unknown, raw?: string) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

test("health endpoint", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.status, "up");
});

test("full compare lifecycle over HTTP", async () => {
  const payload = { key: "api.user", data: { user: { address: { city: "beijing" }, tags: ["a", "b"] } } };
  const created = await (await post("/snapshots/compare", payload)).json();
  assert.equal(created.ok, true);
  assert.equal(created.data.status, "created");

  const changed = await post("/snapshots/compare", {
    key: "api.user",
    data: { user: { address: { city: "shanghai" }, tags: ["a"] } },
  });
  const changedBody = await changed.json();
  assert.equal(changedBody.data.status, "failed");
  assert.deepEqual(changedBody.data.diff, [
    { path: "user.address.city", kind: "changed", before: "beijing", after: "shanghai" },
    { path: "user.tags[1]", kind: "removed", before: "b" },
  ]);

  const replay = await fetch(base + "/runs/" + changedBody.runId);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.status, "failed");
  assert.equal(replayBody.data.key, "api.user");
});

test("ignored field path passes despite changed timestamp", async () => {
  await post("/snapshots/compare", { key: "api.ts", data: { id: 7, ts: "2026-01-01" } });
  const res = await post("/snapshots/compare", {
    key: "api.ts",
    data: { id: 7, ts: "2026-10-04" },
    ignorePaths: ["ts"],
  });
  const body = await res.json();
  assert.equal(body.data.status, "passed");
});

test("invalid JSON body returns INPUT_ERROR 400", async () => {
  const res = await post("/snapshots/compare", undefined, "{not json");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.category, "INPUT_ERROR");
});

test("missing required field returns INPUT_ERROR 400", async () => {
  const res = await post("/snapshots/compare", { key: "x" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.category, "INPUT_ERROR");
  assert.match(body.error.message, /data/);
});

test("illegal key returns INPUT_ERROR 400", async () => {
  const res = await post("/snapshots/compare", { key: "bad key!", data: {} });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.category, "INPUT_ERROR");
});

test("oversized body returns RESOURCE_EXHAUSTED 413", async () => {
  const res = await post("/snapshots/compare", { key: "big", data: { blob: "x".repeat(5000) } });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.category, "RESOURCE_EXHAUSTED");
});

test("force update on missing snapshot returns STATE_CONFLICT 409", async () => {
  const res = await post("/snapshots/update", { key: "ghost", data: {} });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.category, "STATE_CONFLICT");
});

test("get and delete snapshot, delete-missing is a conflict", async () => {
  await post("/snapshots/compare", { key: "api.del", data: { v: 1 } });
  const got = await fetch(base + "/snapshots/api.del");
  assert.equal(got.status, 200);
  const del = await fetch(base + "/snapshots/api.del", { method: "DELETE" });
  assert.equal(del.status, 200);
  const delAgain = await fetch(base + "/snapshots/api.del", { method: "DELETE" });
  assert.equal(delAgain.status, 409);
  const body = await delAgain.json();
  assert.equal(body.error.category, "STATE_CONFLICT");
});

test("unknown route returns INPUT_ERROR, never silent success", async () => {
  const res = await fetch(base + "/nope");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.category, "INPUT_ERROR");
});
