import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { SystemClock } from "../src/clock.ts";
import { randomBytes } from "node:crypto";
import { computeS256 } from "../src/core.ts";

const CLIENT = { id: "demo-client", secret: "demo-secret", redirect: "http://localhost:3000/callback" };

const { app, runId } = buildApp({ config: loadConfig({ dbPath: ":memory:" }), clock: new SystemClock() });
console.log("demo runId=" + runId);

const verifier = randomBytes(32).toString("base64url");
const challenge = computeS256(verifier);

const auth = await app.inject({
  method: "GET",
  url: "/authorize?response_type=code&client_id=" + CLIENT.id +
    "&redirect_uri=" + encodeURIComponent(CLIENT.redirect) +
    "&code_challenge=" + challenge + "&code_challenge_method=S256&state=demo",
});
const { code, redirect } = auth.json();
console.log("1) authorize -> redirect:", redirect);

const tok = await app.inject({
  method: "POST", url: "/token",
  payload: { grant_type: "authorization_code", code, redirect_uri: CLIENT.redirect, client_id: CLIENT.id, client_secret: CLIENT.secret, code_verifier: verifier },
});
console.log("2) exchange -> tokens:", JSON.stringify(tok.json(), null, 2));

const rotated = await app.inject({
  method: "POST", url: "/token",
  payload: { grant_type: "refresh_token", refresh_token: tok.json().refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
});
console.log("3) rotate -> new pair issued, old refresh token now invalid");

const replay = await app.inject({
  method: "POST", url: "/token",
  payload: { grant_type: "refresh_token", refresh_token: tok.json().refresh_token, client_id: CLIENT.id, client_secret: CLIENT.secret },
});
console.log("4) replay old refresh token ->", replay.statusCode, replay.body);

const diag = await app.inject({ method: "GET", url: "/diag/state" });
console.log("5) diagnostics:", diag.body);

await app.close();
