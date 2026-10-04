import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { makeVault } from "./helpers.ts";

function makeApp(grace = 1000) {
  const v = makeVault(grace);
  const app = buildServer({ core: v.core, store: v.store, clock: v.clock, runId: v.runId });
  return { app, ...v };
}

test("HTTP contract: put/get/rotate happy path", async () => {
  const { app } = makeApp();
  const put = await app.inject({ method: "PUT", url: "/secrets/svc.token", payload: { value: "tok-1" }, headers: { "x-actor": "tester" } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().data, { name: "svc.token", version: 1 });

  const get = await app.inject({ method: "GET", url: "/secrets/svc.token?version=1" });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().value, "tok-1");

  const rot = await app.inject({ method: "POST", url: "/secrets/svc.token/rotate" });
  assert.equal(rot.statusCode, 200);
  assert.equal(rot.json().version, 2);

  const versions = await app.inject({ method: "GET", url: "/secrets/svc.token/versions" });
  assert.equal(versions.json().versions.length, 2);

  const audit = await app.inject({ method: "GET", url: "/audit?name=svc.token" });
  assert.ok(audit.json().entries.length >= 3);
});

test("HTTP error mapping: 400/404/410 with structured error body", async () => {
  const { app, clock } = makeApp(500);
  const bad = await app.inject({ method: "PUT", url: "/secrets/x", payload: {} });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "VALIDATION_ERROR");

  const missing = await app.inject({ method: "GET", url: "/secrets/ghost" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "SECRET_NOT_FOUND");

  await app.inject({ method: "PUT", url: "/secrets/e", payload: { value: "v" } });
  await app.inject({ method: "POST", url: "/secrets/e/rotate" });
  clock.advance(500); // exactly at graceUntil
  const expired = await app.inject({ method: "GET", url: "/secrets/e?version=1" });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json().error.code, "VERSION_EXPIRED");

  const noVersion = await app.inject({ method: "GET", url: "/secrets/e?version=42" });
  assert.equal(noVersion.statusCode, 404);
  assert.equal(noVersion.json().error.code, "VERSION_NOT_FOUND");
});

test("healthz exposes diagnostics: runId, clock, counts", async () => {
  const { app, runId } = makeApp();
  await app.inject({ method: "PUT", url: "/secrets/h", payload: { value: "v" } });
  const res = await app.inject({ method: "GET", url: "/healthz" });
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.runId, runId);
  assert.equal(body.counts.secrets, 1);
  assert.equal(body.counts.versions, 1);
  assert.ok(body.counts.audit >= 1);
});
