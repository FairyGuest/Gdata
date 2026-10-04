import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { VirtualClock } from "../src/clock.ts";

// RFC 7636 Appendix B reference pair (independent of implementation under test).
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLIENT = { id: "demo-client", secret: "demo-secret", redirect: "http://localhost:3000/callback" };

const T0 = 1_700_000_000_000;

function makeApp(overrides = {}) {
  const clock = new VirtualClock(T0);
  const config = loadConfig({ dbPath: ":memory:", ...overrides });
  const built = buildApp({ config, clock });
  return { clock, ...built };
}

async function getCode(app: any, challenge = CHALLENGE) {
  const res = await app.inject({
    method: "GET",
    url: "/authorize?response_type=code&client_id=" + CLIENT.id +
      "&redirect_uri=" + encodeURIComponent(CLIENT.redirect) +
      "&code_challenge=" + challenge + "&code_challenge_method=S256&state=xyz",
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { code: string; redirect: string };
}

async function exchange(app: any, code: string, verifier: string) {
  return app.inject({
    method: "POST",
    url: "/token",
    payload: {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT.redirect,
      client_id: CLIENT.id,
      client_secret: CLIENT.secret,
      code_verifier: verifier,
    },
  });
}

test("happy path: authorize -> exchange -> introspect active", async () => {
  const { app } = makeApp();
  const { code, redirect } = await getCode(app);
  assert.ok(redirect.startsWith(CLIENT.redirect + "?code="));
  assert.ok(redirect.includes("state=xyz"));
  const tok = await exchange(app, code, VERIFIER);
  assert.equal(tok.statusCode, 200, tok.body);
  const body = tok.json();
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.access_token && body.refresh_token);
  const intro = await app.inject({ method: "POST", url: "/introspect", payload: { token: body.access_token } });
  assert.equal(intro.json().active, true);
  await app.close();
});

test("double redemption: second use of same code fails with invalid_grant", async () => {
  const { app } = makeApp();
  const { code } = await getCode(app);
  const first = await exchange(app, code, VERIFIER);
  assert.equal(first.statusCode, 200, first.body);
  const second = await exchange(app, code, VERIFIER);
  assert.equal(second.statusCode, 400);
  const err = second.json();
  assert.equal(err.error, "invalid_grant");
  assert.equal(err.error_category, "state_conflict");
  assert.match(err.error_description, /already been used/);
  await app.close();
});

test("wrong PKCE verifier fails and does NOT consume the code", async () => {
  const { app } = makeApp();
  const { code } = await getCode(app);
  const wrong = await exchange(app, code, "x".repeat(50));
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error, "invalid_grant");
  assert.match(wrong.json().error_description, /PKCE/);
  const retry = await exchange(app, code, VERIFIER);
  assert.equal(retry.statusCode, 200, "code must survive a failed PKCE attempt: " + retry.body);
  await app.close();
});

test("redirect_uri must exactly match registration", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "GET",
    url: "/authorize?response_type=code&client_id=" + CLIENT.id +
      "&redirect_uri=" + encodeURIComponent(CLIENT.redirect + "/evil") +
      "&code_challenge=" + CHALLENGE + "&code_challenge_method=S256",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
  assert.equal(res.json().error_category, "input_error");
  await app.close();
});

test("three TTLs are enforced independently", async () => {
  const { app, clock } = makeApp({ codeTtlMs: 1_000, accessTokenTtlMs: 5_000, refreshTokenTtlMs: 60_000 });

  // 1) code expiry
  const { code: c1 } = await getCode(app);
  clock.advance(1_001);
  const expired = await exchange(app, c1, VERIFIER);
  assert.equal(expired.statusCode, 400);
  assert.match(expired.json().error_description, /expired/);

  // 2) access token expiry while refresh still valid
  const { code: c2 } = await getCode(app);
  const tok = (await exchange(app, c2, VERIFIER)).json();
  clock.advance(5_001);
  const intro = await app.inject({ method: "POST", url: "/introspect", payload: { token: tok.access_token } });
  assert.equal(intro.json().active, false);
  assert.equal(intro.json().reason, "expired");
  const refreshed = await app.inject({
    method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
  });
  assert.equal(refreshed.statusCode, 200, "refresh must still be valid after access expiry: " + refreshed.body);

  // 3) refresh token expiry
  clock.advance(60_001);
  const dead = await app.inject({
    method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: refreshed.json().refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
  });
  assert.equal(dead.statusCode, 400);
  assert.match(dead.json().error_description, /expired/);
  await app.close();
});

test("concurrent refresh rotation: exactly one of two succeeds", async () => {
  const { app } = makeApp();
  const { code } = await getCode(app);
  const tok = (await exchange(app, code, VERIFIER)).json();
  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: "/token", payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret } }),
    app.inject({ method: "POST", url: "/token", payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret } }),
  ]);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(statuses, [200, 400], "exactly one rotation may win, got " + statuses);
  const loser = r1.statusCode === 400 ? r1 : r2;
  assert.equal(loser.json().error, "invalid_grant");
  await app.close();
});

test("refresh token reuse after rotation is rejected and revokes the family", async () => {
  const { app } = makeApp();
  const { code } = await getCode(app);
  const tok = (await exchange(app, code, VERIFIER)).json();
  const rotated = await app.inject({
    method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
  });
  assert.equal(rotated.statusCode, 200);
  const reuse = await app.inject({
    method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
  });
  assert.equal(reuse.statusCode, 400);
  assert.match(reuse.json().error_description, /reuse/);
  const victim = await app.inject({
    method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: rotated.json().refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
  });
  assert.equal(victim.statusCode, 400, "family must be revoked after reuse detection");
  await app.close();
});

test("input errors are distinguishable: bad grant, bad secret, malformed verifier", async () => {
  const { app } = makeApp();
  const badGrant = await app.inject({ method: "POST", url: "/token", payload: { grant_type: "password" } });
  assert.equal(badGrant.json().error, "unsupported_grant_type");
  assert.equal(badGrant.json().error_category, "input_error");

  const { code } = await getCode(app);
  const badSecret = await app.inject({
    method: "POST", url: "/token",
    payload: { grant_type: "authorization_code", code, redirect_uri: CLIENT.redirect, client_id: CLIENT.id, client_secret: "nope", code_verifier: VERIFIER },
  });
  assert.equal(badSecret.statusCode, 401);
  assert.equal(badSecret.json().error, "invalid_client");

  const malformed = await exchange(app, code, "short");
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.json().error_description, /code_verifier/);
  await app.close();
});

test("resource exhaustion: code quota returns temporarily_unavailable", async () => {
  const { app } = makeApp({ maxCodesPerClient: 2 });
  await getCode(app);
  await getCode(app);
  const res = await app.inject({
    method: "GET",
    url: "/authorize?response_type=code&client_id=" + CLIENT.id +
      "&redirect_uri=" + encodeURIComponent(CLIENT.redirect) +
      "&code_challenge=" + CHALLENGE + "&code_challenge_method=S256",
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "temporarily_unavailable");
  assert.equal(res.json().error_category, "resource_exhausted");
  await app.close();
});

test("diagnostics expose run id, state counters and audit reasons", async () => {
  const { app, runId } = makeApp();
  const health = (await app.inject({ method: "GET", url: "/diag/health" })).json();
  assert.equal(health.runId, runId);
  const { code } = await getCode(app);
  await exchange(app, code, VERIFIER);
  const state = (await app.inject({ method: "GET", url: "/diag/state" })).json();
  assert.equal(state.store.codesConsumed, 1);
  assert.equal(state.store.refreshActive, 1);
  const audit = (await app.inject({ method: "GET", url: "/diag/audit" })).json();
  assert.ok(audit.events.length >= 2);
  for (const e of audit.events) {
    assert.equal(e.runId, runId);
    assert.ok(e.reason.length > 0);
  }
  await app.close();
});
