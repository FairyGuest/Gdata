
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeHarness, authorize, exchange, refresh,
  VERIFIER, CLIENT_ID, REDIRECT_URI,
} from "./helpers.ts";

test("happy path: authorize -> exchange -> refresh rotation", async () => {
  const h = makeHarness();
  const az = await authorize(h.app);
  assert.equal(az.statusCode, 200);
  const { code } = az.json();

  const tok = await exchange(h.app, code, VERIFIER);
  assert.equal(tok.statusCode, 200);
  const body = tok.json();
  assert.equal(body.tokenType, "Bearer");
  assert.equal(body.expiresIn, h.config.accessTokenTtlSec);
  assert.ok(body.accessToken && body.refreshToken);

  const ref = await refresh(h.app, body.refreshToken);
  assert.equal(ref.statusCode, 200);
  const rotated = ref.json();
  assert.notEqual(rotated.refreshToken, body.refreshToken, "rotation must issue a new refresh token");
  await h.app.close();
});

test("same code exchanged twice: second call fails with invalid_grant/state", async () => {
  const h = makeHarness();
  const { code } = (await authorize(h.app)).json();
  const first = await exchange(h.app, code, VERIFIER);
  assert.equal(first.statusCode, 200);
  const second = await exchange(h.app, code, VERIFIER);
  assert.equal(second.statusCode, 400);
  const err = second.json();
  assert.equal(err.error, "invalid_grant");
  assert.equal(err.error_category, "state");
  assert.match(err.error_description, /already used/);
  // no silent re-issue: second response carries no tokens
  assert.equal(err.accessToken, undefined);
  await h.app.close();
});

test("wrong PKCE verifier fails and does NOT consume the code", async () => {
  const h = makeHarness();
  const { code } = (await authorize(h.app)).json();
  const bad = await exchange(h.app, code, "wrong-verifier");
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_grant");
  assert.match(bad.json().error_description, /PKCE/);
  // code still usable with the correct verifier
  const good = await exchange(h.app, code, VERIFIER);
  assert.equal(good.statusCode, 200);
  assert.ok(good.json().accessToken);
  await h.app.close();
});

test("redirect_uri must exactly match at authorize and at token", async () => {
  const h = makeHarness();
  const badAz = await h.app.inject({
    method: "POST", url: "/authorize",
    payload: {
      response_type: "code", client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI + "/", // trailing slash: not an exact match
      code_challenge: "x", code_challenge_method: "S256",
    },
  });
  assert.equal(badAz.statusCode, 400);
  assert.equal(badAz.json().error, "invalid_grant");

  const { code } = (await authorize(h.app)).json();
  const badTok = await exchange(h.app, code, VERIFIER, "http://evil.example/callback");
  assert.equal(badTok.statusCode, 400);
  assert.equal(badTok.json().error, "invalid_grant");
  // mismatch must not consume the code either
  const good = await exchange(h.app, code, VERIFIER);
  assert.equal(good.statusCode, 200);
  await h.app.close();
});

test("three independent expiries: code, access token, refresh token", async () => {
  const h = makeHarness({ codeTtlSec: 60, accessTokenTtlSec: 300, refreshTokenTtlSec: 3600 });

  // 1) code expiry: advance past code TTL, exchange must fail expired
  const az1 = await authorize(h.app);
  const { code: code1 } = az1.json();
  h.clock.advance(61);
  const expiredCode = await exchange(h.app, code1, VERIFIER);
  assert.equal(expiredCode.statusCode, 400);
  assert.match(expiredCode.json().error_description, /expired/);

  // 2) fresh code, exchange ok; access token expires independently of refresh
  const { code: code2 } = (await authorize(h.app)).json();
  const tok = (await exchange(h.app, code2, VERIFIER)).json();
  h.clock.advance(300); // now past access TTL, well within refresh TTL
  const diag1 = (await h.app.inject({
    method: "GET",
    url: "/diagnostics/state?accessToken=" + tok.accessToken + "&refreshToken=" + tok.refreshToken,
  })).json();
  assert.equal(diag1.accessToken.expired, true, "access token must be expired");
  assert.equal(diag1.refreshToken.expired, false, "refresh token must still be valid");

  // refresh still works -> proves refresh expiry is independent of access expiry
  const ref = await refresh(h.app, tok.refreshToken);
  assert.equal(ref.statusCode, 200);
  const rotated = ref.json();

  // 3) advance past refresh TTL: rotated refresh token now expired
  h.clock.advance(3600);
  const expiredRef = await refresh(h.app, rotated.refreshToken);
  assert.equal(expiredRef.statusCode, 400);
  assert.match(expiredRef.json().error_description, /expired/);
  await h.app.close();
});

test("concurrent refresh rotation: exactly one of two callers succeeds", async () => {
  const h = makeHarness();
  const { code } = (await authorize(h.app)).json();
  const tok = (await exchange(h.app, code, VERIFIER)).json();

  const [r1, r2] = await Promise.all([
    refresh(h.app, tok.refreshToken),
    refresh(h.app, tok.refreshToken),
  ]);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(statuses, [200, 400], "exactly one rotation may succeed");
  const loser = r1.statusCode === 400 ? r1 : r2;
  assert.equal(loser.json().error, "invalid_grant");
  assert.equal(loser.json().error_category, "state");

  // the old token is dead afterwards too
  const again = await refresh(h.app, tok.refreshToken);
  assert.equal(again.statusCode, 400);
  await h.app.close();
});

test("input errors are distinguishable from state errors", async () => {
  const h = makeHarness();
  const missing = await h.app.inject({ method: "POST", url: "/token", payload: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "invalid_request");
  assert.equal(missing.json().error_category, "input");
  await h.app.close();
});
