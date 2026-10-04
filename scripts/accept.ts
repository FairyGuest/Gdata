import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { VirtualClock } from "../src/clock.ts";

// RFC 7636 Appendix B reference pair (independent of implementation under test).
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLIENT = { id: "demo-client", secret: "demo-secret", redirect: "http://localhost:3000/callback" };

const clock = new VirtualClock(1_700_000_000_000);
const config = loadConfig({ dbPath: ":memory:", codeTtlMs: 1_000, accessTokenTtlMs: 5_000, refreshTokenTtlMs: 60_000 });
const { app, runId } = buildApp({ config, clock });

let failures = 0;
let stepNo = 0;

function show(label: string, value: unknown): void {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  console.log("    " + label + ": " + (s.length > 220 ? s.slice(0, 220) + "..." : s));
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  stepNo++;
  console.log("\n[STEP " + stepNo + "] " + name);
  try {
    await fn();
    console.log("  => PASS");
  } catch (err) {
    failures++;
    console.log("  => FAIL: " + (err instanceof Error ? err.message : String(err)));
  }
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function authorize(): Promise<string> {
  const url = "/authorize?response_type=code&client_id=" + CLIENT.id +
    "&redirect_uri=" + encodeURIComponent(CLIENT.redirect) +
    "&code_challenge=" + CHALLENGE + "&code_challenge_method=S256";
  show("GET", url);
  const res = await app.inject({ method: "GET", url });
  show("response", res.body);
  expect(res.statusCode === 200, "authorize failed: " + res.body);
  return res.json().code;
}

async function token(payload: Record<string, unknown>) {
  show("POST /token", payload);
  const res = await app.inject({ method: "POST", url: "/token", payload });
  show("response", res.body);
  return res;
}

const exchangePayload = (code: string, verifier: string) => ({
  grant_type: "authorization_code",
  code,
  redirect_uri: CLIENT.redirect,
  client_id: CLIENT.id,
  client_secret: CLIENT.secret,
  code_verifier: verifier,
});

const refreshPayload = (rt: string) => ({
  grant_type: "refresh_token",
  refresh_token: rt,
  client_id: CLIENT.id,
  client_secret: CLIENT.secret,
});

console.log("=== OAuth2 authorization-code acceptance run ===");
console.log("runId=" + runId + " clock=virtual t0=" + clock.now());
console.log("ttls: code=" + config.codeTtlMs + "ms access=" + config.accessTokenTtlMs + "ms refresh=" + config.refreshTokenTtlMs + "ms");

let happyTokens: any;

await step("S1 happy path: full authorize -> exchange -> introspect", async () => {
  const code = await authorize();
  const res = await token(exchangePayload(code, VERIFIER));
  expect(res.statusCode === 200, "exchange failed");
  happyTokens = res.json();
  const intro = await app.inject({ method: "POST", url: "/introspect", payload: { token: happyTokens.access_token } });
  show("introspect", intro.body);
  expect(intro.json().active === true, "access token should be active");
});

await step("S2 double redemption: second use of same code is rejected", async () => {
  const code = await authorize();
  const first = await token(exchangePayload(code, VERIFIER));
  expect(first.statusCode === 200, "first exchange should succeed");
  const second = await token(exchangePayload(code, VERIFIER));
  expect(second.statusCode === 400, "second exchange must fail, got " + second.statusCode);
  expect(second.json().error === "invalid_grant", "expected invalid_grant");
  expect(second.json().error_category === "state_conflict", "expected state_conflict category");
});

await step("S3 wrong PKCE verifier: rejected, code NOT consumed, retry succeeds", async () => {
  const code = await authorize();
  const wrong = await token(exchangePayload(code, "x".repeat(50)));
  expect(wrong.statusCode === 400, "wrong verifier must fail");
  expect(/PKCE/.test(wrong.json().error_description), "expected PKCE failure reason");
  const retry = await token(exchangePayload(code, VERIFIER));
  expect(retry.statusCode === 200, "code must survive failed PKCE attempt");
});

await step("S4 redirect_uri exact match: unregistered URI rejected at authorize", async () => {
  const url = "/authorize?response_type=code&client_id=" + CLIENT.id +
    "&redirect_uri=" + encodeURIComponent(CLIENT.redirect + "/evil") +
    "&code_challenge=" + CHALLENGE + "&code_challenge_method=S256";
  show("GET", url);
  const res = await app.inject({ method: "GET", url });
  show("response", res.body);
  expect(res.statusCode === 400, "must reject unknown redirect_uri");
  expect(res.json().error === "invalid_request", "expected invalid_request");
});

await step("S5 independent TTLs: code / access / refresh expire on their own clocks", async () => {
  const c1 = await authorize();
  clock.advance(config.codeTtlMs + 1);
  show("clock", "advanced past code TTL, now=" + clock.now());
  const expired = await token(exchangePayload(c1, VERIFIER));
  expect(expired.statusCode === 400 && /expired/.test(expired.json().error_description), "expired code must be rejected");

  const c2 = await authorize();
  const tok = (await token(exchangePayload(c2, VERIFIER))).json();
  clock.advance(config.accessTokenTtlMs + 1);
  show("clock", "advanced past access TTL, now=" + clock.now());
  const intro = await app.inject({ method: "POST", url: "/introspect", payload: { token: tok.access_token } });
  show("introspect", intro.body);
  expect(intro.json().active === false && intro.json().reason === "expired", "access token must be expired");
  const stillAlive = await token(refreshPayload(tok.refresh_token));
  expect(stillAlive.statusCode === 200, "refresh token must outlive access token");

  clock.advance(config.refreshTokenTtlMs + 1);
  show("clock", "advanced past refresh TTL, now=" + clock.now());
  const dead = await token(refreshPayload(stillAlive.json().refresh_token));
  expect(dead.statusCode === 400 && /expired/.test(dead.json().error_description), "expired refresh token must be rejected");
});

await step("S6 concurrent rotation: same refresh token used twice, exactly one wins", async () => {
  const code = await authorize();
  const tok = (await token(exchangePayload(code, VERIFIER))).json();
  const [r1, r2] = await Promise.all([
    app.inject({ method: "POST", url: "/token", payload: refreshPayload(tok.refresh_token) }),
    app.inject({ method: "POST", url: "/token", payload: refreshPayload(tok.refresh_token) }),
  ]);
  show("response A", r1.statusCode);
  show("response B", r2.statusCode);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  expect(statuses[0] === 200 && statuses[1] === 400, "exactly one rotation must succeed, got " + statuses);
});

await step("S7 rotation reuse: old refresh token replayed after rotation -> family revoked", async () => {
  const code = await authorize();
  const tok = (await token(exchangePayload(code, VERIFIER))).json();
  const rotated = await token(refreshPayload(tok.refresh_token));
  expect(rotated.statusCode === 200, "rotation should succeed");
  const reuse = await token(refreshPayload(tok.refresh_token));
  expect(reuse.statusCode === 400, "reused old refresh token must fail");
  expect(/reuse/.test(reuse.json().error_description), "expected reuse detection reason");
  const victim = await token(refreshPayload(rotated.json().refresh_token));
  expect(victim.statusCode === 400, "family must be revoked after reuse detection");
});

const diag = (await app.inject({ method: "GET", url: "/diag/state" })).json();
console.log("\n=== final diagnostics ===");
console.log(JSON.stringify(diag, null, 2));

await app.close();
console.log("\n=== RESULT: " + (failures === 0 ? "ALL " + stepNo + " SCENARIOS PASSED" : failures + " of " + stepNo + " SCENARIOS FAILED") + " ===");
process.exit(failures === 0 ? 0 : 1);
