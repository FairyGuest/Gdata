
/**
 * One-shot acceptance drill. Runs every scenario in a fixed order against
 * an in-process server driven by a VirtualClock, prints each request,
 * response and verdict, exits 0 only if all pass.
 */
import { VirtualClock } from "../src/clock.ts";
import { loadConfig, CLIENT_FIXTURES, type ServiceConfig } from "../src/config.ts";
import { SqliteStore } from "../src/store.ts";
import { buildServer } from "../src/server.ts";

const VERIFIER = "test-verifier-42";
// Known-answer vector, computed independently of the implementation.
const CHALLENGE = "x8vG52ukahb_xp8Gz8KVy9ydVbpBWmExYObHQJz_dJM";
const CLIENT_ID = "demo-client";
const REDIRECT_URI = "http://localhost:8080/callback";

const config: ServiceConfig = {
  ...loadConfig({}),
  dbPath: ":memory:",
  codeTtlSec: 60,
  accessTokenTtlSec: 300,
  refreshTokenTtlSec: 3600,
};
const clock = new VirtualClock(1_700_000_000);
const store = new SqliteStore(":memory:");
const app = buildServer({ config, clock, store, clients: CLIENT_FIXTURES });

let failures = 0;
let stepNo = 0;

function verdict(ok: boolean, label: string, detail: string) {
  console.log("  VERDICT: " + (ok ? "PASS" : "FAIL") + " -- " + label + " | " + detail);
  if (!ok) failures++;
}

async function step(title: string, method: string, url: string, payload?: unknown) {
  stepNo++;
  console.log("\n[step " + stepNo + "] " + title);
  console.log("  request : " + method + " " + url + (payload ? " " + JSON.stringify(payload) : ""));
  const res = await app.inject({ method: method as never, url, payload: payload as never });
  console.log("  response: " + res.statusCode + " " + res.body);
  return res;
}

async function authorize(challenge = CHALLENGE) {
  return step("authorize", "POST", "/authorize", {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
}
async function exchange(code: string, verifier: string, redirectUri = REDIRECT_URI) {
  return step("token exchange", "POST", "/token", {
    grant_type: "authorization_code",
    code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier,
  });
}
async function doRefresh(token: string) {
  return step("refresh", "POST", "/token", { grant_type: "refresh_token", refresh_token: token });
}

// --- scenario 1: happy path -------------------------------------------------
console.log("=== scenario 1: happy path authorize -> exchange -> refresh rotation ===");
const az = await authorize();
const code1 = az.json().code as string;
verdict(az.statusCode === 200 && !!code1, "authorize issues a code", "status=" + az.statusCode);
const tok1 = await exchange(code1, VERIFIER);
const t1 = tok1.json();
verdict(tok1.statusCode === 200 && !!t1.accessToken && !!t1.refreshToken,
  "code exchanges for tokens", "status=" + tok1.statusCode);
const ref1 = await doRefresh(t1.refreshToken);
const r1 = ref1.json();
verdict(ref1.statusCode === 200 && r1.refreshToken !== t1.refreshToken,
  "refresh rotates to a new token", "status=" + ref1.statusCode);

// --- scenario 2: double redemption of the same code -------------------------
console.log("\n=== scenario 2: same authorization code redeemed twice ===");
const code2 = (await authorize()).json().code as string;
const first = await exchange(code2, VERIFIER);
verdict(first.statusCode === 200, "first redemption succeeds", "status=" + first.statusCode);
const second = await exchange(code2, VERIFIER);
const secondBody = second.json();
verdict(
  second.statusCode === 400 && secondBody.error === "invalid_grant" &&
    secondBody.error_category === "state" && !secondBody.accessToken,
  "second redemption rejected, no silent re-issue",
  "status=" + second.statusCode + " error=" + secondBody.error,
);

// --- scenario 3: wrong PKCE verifier does not consume the code --------------
console.log("\n=== scenario 3: wrong PKCE verifier ===");
const code3 = (await authorize()).json().code as string;
const bad = await exchange(code3, "wrong-verifier");
verdict(bad.statusCode === 400 && bad.json().error === "invalid_grant",
  "wrong verifier rejected", "status=" + bad.statusCode);
const diag = await step("diagnostics: code must be unconsumed", "GET",
  "/diagnostics/state?code=" + code3);
verdict(diag.json().code.consumed === false, "code not consumed by failed PKCE",
  "consumed=" + diag.json().code.consumed);
const good = await exchange(code3, VERIFIER);
verdict(good.statusCode === 200, "code still redeemable with correct verifier",
  "status=" + good.statusCode);

// --- scenario 4: redirect_uri exact match ------------------------------------
console.log("\n=== scenario 4: redirect_uri exact match ===");
const badAz = await step("authorize with unregistered redirect_uri", "POST", "/authorize", {
  response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI + "/",
  code_challenge: CHALLENGE, code_challenge_method: "S256",
});
verdict(badAz.statusCode === 400, "non-exact redirect_uri rejected at authorize",
  "status=" + badAz.statusCode);
const code4 = (await authorize()).json().code as string;
const badTok = await exchange(code4, VERIFIER, "http://evil.example/callback");
verdict(badTok.statusCode === 400, "mismatched redirect_uri rejected at token",
  "status=" + badTok.statusCode);

// --- scenario 5: three independent expiries ----------------------------------
console.log("\n=== scenario 5: independent code/access/refresh expiries ===");
const code5 = (await authorize()).json().code as string;
clock.advance(61); // past code TTL
console.log("  [clock] advanced 61s, now=" + clock.nowSec());
const expiredCode = await exchange(code5, VERIFIER);
verdict(expiredCode.statusCode === 400 && /expired/.test(expiredCode.json().error_description),
  "expired code rejected", "status=" + expiredCode.statusCode);

const code6 = (await authorize()).json().code as string;
const tok6 = (await exchange(code6, VERIFIER)).json();
clock.advance(300); // past access TTL, within refresh TTL
console.log("  [clock] advanced 300s, now=" + clock.nowSec());
const diag2 = await step("diagnostics: access expired, refresh valid", "GET",
  "/diagnostics/state?accessToken=" + tok6.accessToken + "&refreshToken=" + tok6.refreshToken);
const d2 = diag2.json();
verdict(d2.accessToken.expired === true && d2.refreshToken.expired === false,
  "access and refresh expire independently",
  "access.expired=" + d2.accessToken.expired + " refresh.expired=" + d2.refreshToken.expired);
const ref6 = await doRefresh(tok6.refreshToken);
verdict(ref6.statusCode === 200, "refresh still works after access expiry",
  "status=" + ref6.statusCode);

clock.advance(3600); // past refresh TTL of the rotated token
console.log("  [clock] advanced 3600s, now=" + clock.nowSec());
const expiredRef = await doRefresh(ref6.json().refreshToken);
verdict(expiredRef.statusCode === 400 && /expired/.test(expiredRef.json().error_description),
  "expired refresh token rejected", "status=" + expiredRef.statusCode);

// --- scenario 6: concurrent refresh rotation ---------------------------------
console.log("\n=== scenario 6: concurrent use of one refresh token ===");
const code7 = (await authorize()).json().code as string;
const tok7 = (await exchange(code7, VERIFIER)).json();
console.log("  firing two concurrent refreshes for the same token");
const [c1, c2] = await Promise.all([
  app.inject({ method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: tok7.refreshToken } }),
  app.inject({ method: "POST", url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: tok7.refreshToken } }),
]);
console.log("  response A: " + c1.statusCode + " " + c1.body);
console.log("  response B: " + c2.statusCode + " " + c2.body);
const statuses = [c1.statusCode, c2.statusCode].sort();
verdict(statuses[0] === 200 && statuses[1] === 400,
  "exactly one concurrent rotation succeeds",
  "statuses=" + JSON.stringify(statuses));

// --- summary -----------------------------------------------------------------
await app.close();
store.close();
console.log("\n========================================");
if (failures === 0) {
  console.log("ACCEPTANCE: all scenarios passed");
  process.exit(0);
} else {
  console.log("ACCEPTANCE: " + failures + " verdict(s) FAILED");
  process.exit(1);
}
