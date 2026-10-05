import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { startServer, type RunningServer } from "../src/server.ts";

let server: RunningServer;
let base: string;

before(async () => {
  server = await startServer(loadConfig({ port: 0, dbPath: ":memory:" }));
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
});

const SCHEMA = {
  fields: {
    id: { type: "integer", min: 1, max: 1000 },
    email: { type: "string", minLength: 5, maxLength: 10 },
    plan: { type: "enum", values: ["free", "pro"] },
  },
};

async function post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test("health endpoint responds ok", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("generate twice with same seed returns identical rows", async () => {
  const payload = { seed: 123, count: 10, schema: SCHEMA };
  const a = await post("/generate", payload);
  const b = await post("/generate", payload);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body.rows, b.body.rows);
});

test("constraint conflict returns 422 CONSTRAINT_CONFLICT", async () => {
  const res = await post("/generate", {
    seed: 1, count: 1,
    schema: { fields: { age: { type: "integer", min: 50, max: 10 } } },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "CONSTRAINT_CONFLICT");
  assert.equal(res.body.error.category, "input");
  assert.ok(typeof res.body.runId === "string");
});

test("invalid input returns 400 SCHEMA_VALIDATION", async () => {
  const res = await post("/generate", { seed: 1, count: 1, schema: { fields: { x: { type: "nope" } } } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "SCHEMA_VALIDATION");
});

test("missing seed returns 400, not 500", async () => {
  const res = await post("/generate", { count: 1, schema: SCHEMA });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "SCHEMA_VALIDATION");
});

test("save, verify and reload a dataset end to end", async () => {
  const save = await post("/datasets", { id: "users-v1", seed: 777, count: 5, schema: SCHEMA });
  assert.equal(save.status, 201);
  assert.equal(save.body.id, "users-v1");

  const verify = await post("/datasets/users-v1/verify", {});
  assert.equal(verify.status, 200);
  assert.equal(verify.body.match, true);

  const res = await fetch(base + "/datasets/users-v1");
  assert.equal(res.status, 200);
  const stored = await res.json();
  assert.equal(stored.rows.length, 5);
  assert.equal(stored.seed, 777);
});

test("duplicate dataset id returns 409 STATE_CONFLICT", async () => {
  const res = await post("/datasets", { id: "users-v1", seed: 1, count: 1, schema: SCHEMA });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "STATE_CONFLICT");
  assert.equal(res.body.error.category, "state");
});

test("unknown dataset returns 404 NOT_FOUND", async () => {
  const res = await fetch(base + "/datasets/does-not-exist");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "NOT_FOUND");
});

test("diagnostics endpoint exposes run logs with runId", async () => {
  const gen = await post("/generate", { seed: 5, count: 1, schema: SCHEMA });
  const runId = gen.body.runId as string;
  const res = await fetch(base + `/diagnostics/logs?runId=${runId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.logs.length >= 2);
  assert.ok(body.logs.every((e: any) => e.runId === runId));
});
