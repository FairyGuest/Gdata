// One-shot acceptance script: exercises every required scenario in a fixed
// order against a real HTTP server instance, printing request, response and
// decision at each step. Exit 0 when all pass, 1 otherwise.
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let step = 0;

function report(name: string, ok: boolean, detail: unknown) {
  step += 1;
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${tag}] step ${step}: ${name}`);
  console.log(JSON.stringify(detail, null, 2));
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function expectCheck(name: string, roles: string[], resource: string, action: string, wantAllowed: boolean) {
  const req = { subject: { roles }, resource, action };
  const res = await call("POST", "/check", req);
  const d = res.body;
  report(
    `${name} -> allowed=${d.allowed} (expected ${wantAllowed})`,
    res.status === 200 && d.allowed === wantAllowed,
    { request: req, allowed: d.allowed, reasons: d.reasons, matched: d.matched, runId: d.runId, snapshotVersion: d.snapshotVersion },
  );
}

async function main() {
  const config = loadConfig({ RBAC_DB_PATH: ":memory:", RBAC_PORT: String(PORT) } as NodeJS.ProcessEnv);
  const { app } = buildApp(config);
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log("acceptance: server up on " + BASE);

  // --- Scenario 1: diamond inheritance -------------------------------------
  //       base
  //      /    \
  //   left    right
  //      \   /
  //      grand
  await call("PUT", "/roles/base", { inherits: [] });
  await call("PUT", "/roles/left", { inherits: ["base"] });
  await call("PUT", "/roles/right", { inherits: ["base"] });
  await call("PUT", "/roles/grand", { inherits: ["left", "right"] });
  await call("PUT", "/policies/p-base-read", { role: "base", resource: "docs/*", action: "read", effect: "allow" });
  await call("PUT", "/policies/p-left-write", { role: "left", resource: "docs/draft", action: "write", effect: "allow" });

  const diamond = await call("POST", "/check", { subject: { roles: ["grand"] }, resource: "docs/readme", action: "read" });
  const baseHits = diamond.body.matched.filter((m: any) => m.policyId === "p-base-read").length;
  report(
    "diamond: grand inherits base permission exactly once",
    diamond.body.allowed === true && baseHits === 1 &&
      diamond.body.expandedRoles.join(",") === "base,grand,left,right",
    diamond.body,
  );
  await expectCheck("diamond: branch permission via left", ["grand"], "docs/draft", "write", true);

  // --- Scenario 2: wildcard matching ---------------------------------------
  await expectCheck("wildcard: docs/* covers docs/guide", ["grand"], "docs/guide", "read", true);
  await expectCheck("wildcard: docs/* does not cover nested docs/a/b", ["grand"], "docs/a/b", "read", false);

  // --- Scenario 3: deny overrides allow -------------------------------------
  await call("PUT", "/policies/p-right-deny", { role: "right", resource: "docs/secret", action: "read", effect: "deny" });
  await expectCheck("deny overrides allow on docs/secret", ["grand"], "docs/secret", "read", false);

  // --- Scenario 4: default deny ---------------------------------------------
  await expectCheck("default deny on unmatched resource", ["grand"], "admin/panel", "read", false);

  // --- Scenario 5: hot policy update ----------------------------------------
  const before = await call("POST", "/check", { subject: { roles: ["left"] }, resource: "docs/hot", action: "delete" });
  await call("PUT", "/policies/p-hot", { role: "base", resource: "docs/hot", action: "delete", effect: "allow" });
  const after = await call("POST", "/check", { subject: { roles: ["left"] }, resource: "docs/hot", action: "delete" });
  report(
    "hot update: new allow rule effective immediately",
    before.body.allowed === false && after.body.allowed === true &&
      after.body.snapshotVersion > before.body.snapshotVersion,
    { before: before.body.allowed, after: after.body.allowed, versionBefore: before.body.snapshotVersion, versionAfter: after.body.snapshotVersion },
  );
  const del = await call("DELETE", "/policies/p-hot");
  report("hot delete: DELETE returns 200", del.status === 200 && del.body.deleted === true, del);
  const removed = await call("POST", "/check", { subject: { roles: ["left"] }, resource: "docs/hot", action: "delete" });
  report("hot delete: rule removal effective immediately", removed.body.allowed === false, removed.body);

  // --- Scenario 6: error categories -----------------------------------------
  const badInput = await call("POST", "/check", { subject: {} });
  report("error category INPUT_ERROR", badInput.status === 400 && badInput.body.error.category === "INPUT_ERROR", badInput);
  const conflict = await call("PUT", "/policies/p-ghost", { role: "ghost", resource: "a", action: "b", effect: "allow" });
  report("error category STATE_CONFLICT", conflict.status === 409 && conflict.body.error.category === "STATE_CONFLICT", conflict);

  // --- Scenario 7: diagnostics replay ---------------------------------------
  const diag = await call("GET", "/diagnostics/decisions?limit=100");
  report(
    "diagnostics: every decision has runId and reasons",
    diag.status === 200 && diag.body.length >= 8 &&
      diag.body.every((e: any) => e.runId && e.decision.reasons.length > 0),
    { entries: diag.body.length, sample: diag.body[diag.body.length - 1] },
  );

  await app.close();
  console.log(failures === 0 ? `ACCEPT OK (${step} steps)` : `ACCEPT FAILED (${failures}/${step} steps failed)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("acceptance crashed:", err);
  process.exitCode = 1;
});

