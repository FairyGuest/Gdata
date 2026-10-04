import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { VirtualClock } from "../src/clock.ts";
import { TokenStore } from "../src/store.ts";
import { TokenService } from "../src/service.ts";
import { buildServer } from "../src/http.ts";

const SECRET = "test-secret";
const T0 = 1_700_000_000_000;

function makeService(log: any[] = []) {
  const clock = new VirtualClock(T0);
  const store = new TokenStore(":memory:");
  const service = new TokenService(store, clock, SECRET, "test-run", (e) => log.push(e));
  return { clock, store, service, log };
}

// Reference token built independently of src/jwt.ts (test-owned oracle).
function referenceToken(claims: object): string {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = createHmac("sha256", SECRET).update(h + "." + p).digest("base64url");
  return h + "." + p + "." + s;
}

test("issue: token matches independently computed HS256 reference", () => {
  const { service } = makeService();
  const r = service.issue({ sub: "alice", scope: ["read", "write"], ttlMs: 60_000 });
  assert.ok(r.ok);
  const expected = referenceToken({
    sub: "alice",
    jti: r.value.jti,
    scope: ["read", "write"],
    iat: T0,
    exp: T0 + 60_000,
  });
  assert.equal(r.value.token, expected);
  assert.equal(r.value.exp - r.value.iat, 60_000);
});

test("validate: active token is accepted with claims echoed", () => {
  const { service } = makeService();
  const issued = service.issue({ sub: "bob", scope: ["read"], ttlMs: 5_000 });
  assert.ok(issued.ok);
  const v = service.validate(issued.value.token);
  assert.ok(v.ok);
  assert.deepEqual(v.value.scope, ["read"]);
  assert.equal(v.value.sub, "bob");
});

test("expiry boundary: valid at exp-1ms, expired exactly at exp", () => {
  const { service, clock } = makeService();
  const issued = service.issue({ sub: "carol", scope: ["read"], ttlMs: 1_000 });
  assert.ok(issued.ok);
  clock.set(T0 + 999);
  assert.ok(service.validate(issued.value.token).ok, "should be valid 1ms before exp");
  clock.set(T0 + 1_000);
  const v = service.validate(issued.value.token);
  assert.ok(!v.ok);
  assert.equal(v.error.code, "expired");
  assert.equal(v.error.reason, "expired");
});

test("revoke: validate after revoke fails with code revoked", () => {
  const { service } = makeService();
  const issued = service.issue({ sub: "dave", scope: ["read"], ttlMs: 60_000 });
  assert.ok(issued.ok);
  const rv = service.revoke(issued.value.token);
  assert.ok(rv.ok);
  const v = service.validate(issued.value.token);
  assert.ok(!v.ok);
  assert.equal(v.error.code, "revoked");
  const rv2 = service.revoke(issued.value.token);
  assert.ok(!rv2.ok);
  assert.equal(rv2.error.code, "revoked");
});

test("refresh: old token becomes rotated, new token validates", () => {
  const { service } = makeService();
  const issued = service.issue({ sub: "erin", scope: ["read", "admin"], ttlMs: 60_000 });
  assert.ok(issued.ok);
  const refreshed = service.refresh(issued.value.token);
  assert.ok(refreshed.ok);
  assert.notEqual(refreshed.value.jti, issued.value.jti);
  assert.deepEqual(refreshed.value.scope, ["read", "admin"]);

  const oldV = service.validate(issued.value.token);
  assert.ok(!oldV.ok);
  assert.equal(oldV.error.code, "rotated");

  const newV = service.validate(refreshed.value.token);
  assert.ok(newV.ok);

  // Re-using the rotated token for refresh must also fail as rotated.
  const again = service.refresh(issued.value.token);
  assert.ok(!again.ok);
  assert.equal(again.error.code, "rotated");
});

test("concurrent double refresh: exactly one succeeds", async () => {
  const { service } = makeService();
  const app = buildServer({ service });
  const issued = service.issue({ sub: "frank", scope: ["read"], ttlMs: 60_000 });
  assert.ok(issued.ok);
  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: "/tokens/refresh", payload: { token: issued.value.token } }),
    app.inject({ method: "POST", url: "/tokens/refresh", payload: { token: issued.value.token } }),
  ]);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, "exactly one refresh may succeed");
  const loser = [r1, r2].find((r) => r.statusCode !== 200)!;
  const loserCode = loser.json().error.code;
  assert.ok(
    loserCode === "rotated" || loserCode === "refresh_conflict",
    "loser must fail as rotated or refresh_conflict, got " + loserCode
  );
  await app.close();
});

test("bad signature: invalid_token with reason bad_signature", () => {
  const { service } = makeService();
  const issued = service.issue({ sub: "gina", scope: ["read"], ttlMs: 60_000 });
  assert.ok(issued.ok);
  const tampered = issued.value.token.slice(0, -2) + "xx";
  const v = service.validate(tampered);
  assert.ok(!v.ok);
  assert.equal(v.error.code, "invalid_token");
  assert.equal(v.error.reason, "bad_signature");
});

test("malformed token: invalid_token with reason malformed", () => {
  const { service } = makeService();
  const v = service.validate("not-a-jwt");
  assert.ok(!v.ok);
  assert.equal(v.error.code, "invalid_token");
  assert.equal(v.error.reason, "malformed");
});

test("unknown jti: valid signature but unknown id is invalid_token/unknown_jti", () => {
  const { service } = makeService();
  const forged = referenceToken({
    sub: "mallory", jti: "does-not-exist", scope: ["read"], iat: T0, exp: T0 + 60_000,
  });
  const v = service.validate(forged);
  assert.ok(!v.ok);
  assert.equal(v.error.code, "invalid_token");
  assert.equal(v.error.reason, "unknown_jti");
});

test("contract: invalid issue input is rejected as invalid_input", async () => {
  const { service } = makeService();
  const app = buildServer({ service });
  const r = await app.inject({
    method: "POST", url: "/tokens",
    payload: { sub: "x", scope: [], ttlMs: -5 },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error.code, "invalid_input");
  const r2 = await app.inject({ method: "POST", url: "/tokens/validate", payload: {} });
  assert.equal(r2.statusCode, 400);
  assert.equal(r2.json().error.code, "invalid_input");
  await app.close();
});

test("decision log: records runId, jti, decision and reason for replay", () => {
  const log: any[] = [];
  const { service } = makeService(log);
  const issued = service.issue({ sub: "henry", scope: ["read"], ttlMs: 1_000 });
  assert.ok(issued.ok);
  service.revoke(issued.value.token);
  service.validate(issued.value.token);
  assert.ok(log.every((e) => e.runId === "test-run"));
  const rejected = log.filter((e) => e.decision === "rejected");
  assert.ok(rejected.length >= 1);
  assert.ok(rejected.some((e) => e.reason.includes("revoked")));
  assert.ok(log.every((e) => typeof e.at === "number" && typeof e.op === "string"));
});