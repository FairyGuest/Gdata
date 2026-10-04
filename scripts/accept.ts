/**
 * One-shot acceptance script: boots the service on an ephemeral port and
 * walks every required scenario in a fixed order, printing each request,
 * response and decision. Exits 0 only if every scenario passes.
 */
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server/app.ts";
import { PolicyStore } from "../src/state/store.ts";
import { parsePolicyDocument } from "../src/contract/validate.ts";

let failures = 0;
let step = 0;

function report(ok: boolean, name: string, detail: string) {
  step += 1;
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${tag}] step ${step}: ${name}`);
  console.log(`       ${detail}`);
}

const store = new PolicyStore(":memory:");
const app = buildApp({ store, logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = await res.json();
  console.log(`  -> ${method} ${path}${body === undefined ? "" : " " + JSON.stringify(body)}`);
  console.log(`  <- ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, json: json as Record<string, unknown> };
}

console.log("=== scenario 1: load diamond-inheritance policy fixture ===");
const doc = parsePolicyDocument(
  JSON.parse(readFileSync(new URL("../fixtures/policy.diamond.json", import.meta.url), "utf8")),
);
{
  const r = await call("PUT", "/policy", doc);
  report(r.status === 200 && r.json.ok === true, "policy loaded", `version=${r.json.version}`);
}

console.log("=== scenario 2: diamond inheritance (bottom inherits root wildcard allow) ===");
{
  const r = await call("POST", "/check", { roles: ["bottom"], resource: "docs/team/plan", action: "read" });
  report(
    r.status === 200 && r.json.allow === true && r.json.reason === "ALLOW_RULE_MATCHED",
    "inherited wildcard allow",
    `allow=${r.json.allow} reason=${r.json.reason} effectiveRoles=${JSON.stringify(r.json.effectiveRoles)}`,
  );
  const roles = r.json.effectiveRoles as string[];
  report(
    new Set(roles).size === roles.length && roles.includes("root"),
    "shared ancestor deduplicated",
    `effectiveRoles=${JSON.stringify(roles)}`,
  );
}

console.log("=== scenario 3: deny overrides allow (same resource+action, two branches) ===");
{
  const r = await call("POST", "/check", { roles: ["bottom"], resource: "docs/internal", action: "write" });
  report(
    r.status === 200 && r.json.allow === false && r.json.reason === "DENY_RULE_MATCHED",
    "deny wins over allow",
    `allow=${r.json.allow} reason=${r.json.reason} matched=${JSON.stringify(r.json.matchedRules)}`,
  );
}

console.log("=== scenario 4: wildcard coverage and default deny ===");
{
  const a = await call("POST", "/check", { roles: ["left"], resource: "docs/a/b/c", action: "read" });
  report(a.json.allow === true, "wildcard docs/* covers nested path", `allow=${a.json.allow}`);
  const b = await call("POST", "/check", { roles: ["left"], resource: "images/logo", action: "read" });
  report(
    b.json.allow === false && b.json.reason === "NO_RULE_MATCHED",
    "unmatched request defaults to deny",
    `allow=${b.json.allow} reason=${b.json.reason}`,
  );
}

console.log("=== scenario 5: hot policy update takes effect immediately ===");
{
  const before = await call("POST", "/check", { roles: ["left"], resource: "docs/internal", action: "write" });
  const add = await call("POST", "/policy/rules", { role: "left", effect: "deny", resource: "docs/internal", action: "write" });
  const afterAdd = await call("POST", "/check", { roles: ["left"], resource: "docs/internal", action: "write" });
  report(
    before.json.allow === true && afterAdd.json.allow === false,
    "added deny rule effective immediately",
    `before=${before.json.allow} after=${afterAdd.json.allow} version=${afterAdd.json.policyVersion}`,
  );
  const id = (add.json as { id: number }).id;
  await call("DELETE", `/policy/rules/${id}`);
  const afterDel = await call("POST", "/check", { roles: ["left"], resource: "docs/internal", action: "write" });
  report(afterDel.json.allow === true, "rule removal effective immediately", `allow=${afterDel.json.allow}`);
}

console.log("=== scenario 6: error semantics (input vs conflict) ===");
{
  const bad = await call("POST", "/check", { roles: [], resource: "x", action: "y" });
  const err = bad.json.error as { category: string; code: string };
  report(
    bad.status === 400 && err.category === "input" && err.code === "INVALID_ROLES",
    "invalid input -> 400/input",
    `status=${bad.status} code=${err.code}`,
  );
  const conflict = await call("POST", "/policy/rules", { role: "ghost", effect: "allow", resource: "x", action: "y" });
  const err2 = conflict.json.error as { category: string; code: string };
  report(
    conflict.status === 409 && err2.category === "conflict" && err2.code === "ROLE_NOT_FOUND",
    "unknown role -> 409/conflict",
    `status=${conflict.status} code=${err2.code}`,
  );
}

console.log("=== scenario 7: diagnostics ===");
{
  const r = await call("GET", "/diagnostics/state");
  report(
    r.status === 200 && typeof r.json.version === "number",
    "diagnostics reports policy version",
    JSON.stringify(r.json),
  );
}

await app.close();
store.close();
console.log("");
if (failures > 0) {
  console.error(`ACCEPTANCE FAILED: ${failures} of ${step} checks failed`);
  process.exitCode = 1;
}
console.log(`ACCEPTANCE PASSED: all ${step} checks succeeded`);
process.exitCode = 0;
