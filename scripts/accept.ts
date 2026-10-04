import { VirtualClock } from "../src/clock.ts";
import { TokenStore } from "../src/store.ts";
import { TokenService } from "../src/service.ts";
import { buildServer } from "../src/http.ts";
import { randomUUID } from "node:crypto";

const RUN_ID = "accept-" + randomUUID().slice(0, 8);
const SECRET = "accept-fixture-secret";
const T0 = 1_700_000_000_000;

const clock = new VirtualClock(T0);
const store = new TokenStore(":memory:");
const service = new TokenService(store, clock, SECRET, RUN_ID, (e) => {
  console.log("  [decision]", JSON.stringify(e));
});
const app = buildServer({ service, virtualClock: clock });

let failed = 0;
let step = 0;

function judge(name: string, cond: boolean, detail: string) {
  step += 1;
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failed += 1;
  console.log("[step " + step + "][" + mark + "] " + name + " -- " + detail);
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  console.log("  -> " + method + " " + url + (body ? " " + JSON.stringify(body) : ""));
  console.log("  <- " + res.status + " " + JSON.stringify(json));
  return { status: res.status, json };
}

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = "http://127.0.0.1:" + port;
console.log("accept run " + RUN_ID + " against " + base + " (VirtualClock start " + T0 + ")");

// 1. issue
const issue = await call("POST", "/tokens", { sub: "fixture-user", scope: ["read", "write"], ttlMs: 60_000 });
judge("issue token", issue.status === 201 && typeof issue.json?.token === "string",
  "status=" + issue.status + " jti=" + issue.json?.jti);
const token1 = issue.json?.token ?? "";

// 2. validate ok
const v1 = await call("POST", "/tokens/validate", { token: token1 });
judge("validate active token", v1.status === 200 && v1.json?.valid === true && v1.json?.sub === "fixture-user",
  "status=" + v1.status);

// 3. concurrent double refresh
const [ra, rb] = await Promise.all([
  call("POST", "/tokens/refresh", { token: token1 }),
  call("POST", "/tokens/refresh", { token: token1 }),
]);
const winners = [ra, rb].filter((r) => r.status === 200);
const losers = [ra, rb].filter((r) => r.status !== 200);
const loserCode = losers[0]?.json?.error?.code;
judge("concurrent double refresh: exactly one success",
  winners.length === 1 && losers.length === 1 && (loserCode === "rotated" || loserCode === "refresh_conflict"),
  "winner=" + winners.length + " loserCode=" + loserCode);
const token2 = winners[0]?.json?.token ?? "";

// 4. rotated old token reuse
const vOld = await call("POST", "/tokens/validate", { token: token1 });
judge("rotated token rejected as rotated", vOld.status === 401 && vOld.json?.error?.code === "rotated",
  "status=" + vOld.status + " code=" + vOld.json?.error?.code);
const rOld = await call("POST", "/tokens/refresh", { token: token1 });
judge("rotated token cannot refresh again", rOld.status === 401 && rOld.json?.error?.code === "rotated",
  "status=" + rOld.status + " code=" + rOld.json?.error?.code);

// 5. new token works
const v2 = await call("POST", "/tokens/validate", { token: token2 });
judge("refreshed token validates", v2.status === 200 && v2.json?.valid === true, "status=" + v2.status);

// 6. revoke then validate
const rv = await call("POST", "/tokens/revoke", { token: token2 });
judge("revoke token", rv.status === 200 && rv.json?.status === "revoked", "status=" + rv.status);
const vRv = await call("POST", "/tokens/validate", { token: token2 });
judge("revoked token rejected as revoked", vRv.status === 401 && vRv.json?.error?.code === "revoked",
  "status=" + vRv.status + " code=" + vRv.json?.error?.code);

// 7. expiry boundary via VirtualClock
const short = await call("POST", "/tokens", { sub: "short-lived", scope: ["read"], ttlMs: 1_000 });
const shortToken = short.json?.token ?? "";
await call("POST", "/__clock/advance", { ms: 999 });
const vBefore = await call("POST", "/tokens/validate", { token: shortToken });
judge("valid 1ms before expiry", vBefore.status === 200, "status=" + vBefore.status);
await call("POST", "/__clock/advance", { ms: 1 });
const vExp = await call("POST", "/tokens/validate", { token: shortToken });
judge("expired exactly at exp", vExp.status === 401 && vExp.json?.error?.code === "expired",
  "status=" + vExp.status + " code=" + vExp.json?.error?.code);

// 8. tampered signature
const tampered = token2.slice(0, -2) + "xx";
const vBad = await call("POST", "/tokens/validate", { token: tampered });
judge("tampered signature rejected as invalid_token",
  vBad.status === 401 && vBad.json?.error?.code === "invalid_token" && vBad.json?.error?.reason === "bad_signature",
  "status=" + vBad.status + " reason=" + vBad.json?.error?.reason);

// 9. contract violation
const bad = await call("POST", "/tokens", { sub: "x", scope: "not-an-array", ttlMs: -1 });
judge("invalid input rejected as invalid_input", bad.status === 400 && bad.json?.error?.code === "invalid_input",
  "status=" + bad.status + " code=" + bad.json?.error?.code);

await app.close();
store.close();
console.log("accept run " + RUN_ID + ": " + (failed === 0 ? "ALL " + step + " STEPS PASSED" : failed + " of " + step + " STEPS FAILED"));
process.exitCode = failed === 0 ? 0 : 1;