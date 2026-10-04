import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

function makeApp() {
  const config = loadConfig({
    RBAC_DB_PATH: ":memory:",
    RBAC_MAX_ROLES: "5",
    RBAC_MAX_POLICIES: "20",
  } as NodeJS.ProcessEnv);
  return buildApp(config);
}

async function put(app: any, url: string, body: unknown) {
  return app.inject({ method: "PUT", url, payload: body });
}

test("api: full lifecycle with hot policy update", async () => {
  const { app } = makeApp();
  await put(app, "/roles/viewer", { inherits: [] });
  await put(app, "/roles/editor", { inherits: ["viewer"] });
  await put(app, "/policies/p1", { role: "viewer", resource: "docs/*", action: "read", effect: "allow" });

  const check = async () =>
    (await app.inject({
      method: "POST",
      url: "/check",
      payload: { subject: { roles: ["editor"] }, resource: "docs/a", action: "read" },
    })).json();

  const before = await check();
  assert.equal(before.allowed, true);

  // hot update: add a deny rule, effective immediately
  await put(app, "/policies/p2", { role: "viewer", resource: "docs/*", action: "read", effect: "deny" });
  const after = await check();
  assert.equal(after.allowed, false);
  assert.ok(after.snapshotVersion > before.snapshotVersion);
  assert.ok(after.reasons[0].startsWith("deny overrides allow"));

  // hot delete: remove the deny, allow wins again
  await app.inject({ method: "DELETE", url: "/policies/p2" });
  const restored = await check();
  assert.equal(restored.allowed, true);

  // diagnostics expose run ids and reasons for replay
  const diag = (await app.inject({ method: "GET", url: "/diagnostics/decisions" })).json();
  assert.equal(diag.length, 3);
  assert.ok(diag.every((e: any) => e.runId && e.decision.reasons.length > 0));
  await app.close();
});

test("api: error categories are distinguishable", async () => {
  const { app } = makeApp();

  // INPUT_ERROR: malformed payload
  let res = await app.inject({ method: "POST", url: "/check", payload: { subject: {} } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.category, "INPUT_ERROR");

  // INPUT_ERROR: wildcard in check request
  res = await app.inject({
    method: "POST",
    url: "/check",
    payload: { subject: { roles: ["r"] }, resource: "docs/*", action: "read" },
  });
  assert.equal(res.json().error.category, "INPUT_ERROR");

  // STATE_CONFLICT: policy for unknown role
  res = await put(app, "/policies/px", { role: "ghost", resource: "a", action: "b", effect: "allow" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.category, "STATE_CONFLICT");

  // STATE_CONFLICT: inheritance cycle
  await put(app, "/roles/a", { inherits: [] });
  await put(app, "/roles/b", { inherits: ["a"] });
  res = await put(app, "/roles/a", { inherits: ["b"] });
  assert.equal(res.json().error.category, "STATE_CONFLICT");

  // RESOURCE_EXHAUSTED: role limit (maxRoles=5)
  await put(app, "/roles/c", { inherits: [] });
  await put(app, "/roles/d", { inherits: [] });
  await put(app, "/roles/e", { inherits: [] });
  res = await put(app, "/roles/f", { inherits: [] });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.category, "RESOURCE_EXHAUSTED");

  await app.close();
});

test("api: snapshot consistency under interleaved update and query", async () => {
  const { app } = makeApp();
  await put(app, "/roles/r", { inherits: [] });
  await put(app, "/policies/p1", { role: "r", resource: "x", action: "y", effect: "allow" });

  const check = () =>
    app.inject({ method: "POST", url: "/check", payload: { subject: { roles: ["r"] }, resource: "x", action: "y" } });

  const v1 = (await check()).json().snapshotVersion;
  // multi-statement update (role + policy) commits atomically
  await put(app, "/roles/r2", { inherits: ["r"] });
  await put(app, "/policies/p2", { role: "r2", resource: "x", action: "y", effect: "deny" });
  const res = (await app.inject({
    method: "POST",
    url: "/check",
    payload: { subject: { roles: ["r2"] }, resource: "x", action: "y" },
  })).json();
  assert.equal(res.allowed, false);
  assert.ok(res.snapshotVersion > v1);
  // every observed version is a complete state, never partial
  const diag = (await app.inject({ method: "GET", url: "/diagnostics/decisions" })).json();
  const versions = diag.map((e: any) => e.decision.snapshotVersion);
  assert.deepEqual(versions, [...versions].sort((a: number, b: number) => a - b));
  await app.close();
});

