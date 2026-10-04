import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/http/server";
import { makeService, newRunId, tlog } from "./helpers";

test("HTTP API: append, list, verify, and error mapping", async () => {
  const runId = newRunId();
  const { service, store } = makeService();
  const app = buildServer(service);

  const bad = await app.inject({ method: "POST", url: "/events", payload: { payload: {} } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "INPUT_VALIDATION");

  const r1 = await app.inject({
    method: "POST",
    url: "/events",
    payload: { eventType: "user.login", payload: { userId: "u-1" } },
  });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json().seq, 1);

  const big = await app.inject({
    method: "POST",
    url: "/events",
    payload: { eventType: "e", payload: { big: "x".repeat(5000) } },
  });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error.code, "RESOURCE_EXHAUSTED");

  const list = await app.inject({ method: "GET", url: "/events" });
  assert.equal(list.json().entries.length, 1);

  const verify = await app.inject({ method: "GET", url: "/verify" });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().ok, true);

  tlog(runId, "http-api", {
    badInput: bad.statusCode,
    append: r1.statusCode,
    oversize: big.statusCode,
    verifyOk: verify.json().ok,
  }, "status codes and error codes asserted per contract");

  await app.close();
  store.close();
});

