import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server/app.ts";
import { PolicyStore } from "../src/state/store.ts";
import { parsePolicyDocument } from "../src/contract/validate.ts";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

before(async () => {
  const store = new PolicyStore();
  const doc = parsePolicyDocument(
    JSON.parse(readFileSync(new URL("../fixtures/policy.diamond.json", import.meta.url), "utf8")),
  );
  store.replacePolicy(doc);
  app = buildApp({ store, logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

async function check(roles: string[], resource: string, action: string) {
  const res = await app.inject({
    method: "POST",
    url: "/check",
    payload: { roles, resource, action },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as { allow: boolean; reason: string; policyVersion: number; runId: string };
}

test("diamond: bottom inherits root wildcard allow", async () => {
  const d = await check(["bottom"], "docs/anything", "read");
  assert.equal(d.allow, true);
  assert.equal(d.reason, "ALLOW_RULE_MATCHED");
});

test("diamond: deny from right branch overrides allow from left branch", async () => {
  const d = await check(["bottom"], "docs/internal", "write");
  assert.equal(d.allow, false);
  assert.equal(d.reason, "DENY_RULE_MATCHED");
});

test("wildcard: root rule covers nested docs path but not other resources", async () => {
  assert.equal((await check(["left"], "docs/a/b", "read")).allow, true);
  const d = await check(["left"], "images/logo", "read");
  assert.equal(d.allow, false);
  assert.equal(d.reason, "NO_RULE_MATCHED");
});

test("hot update takes effect immediately on subsequent queries", async () => {
  const before = await check(["left"], "docs/internal", "write");
  assert.equal(before.allow, true, "left alone may write before update");

  const add = await app.inject({
    method: "POST",
    url: "/policy/rules",
    payload: { role: "left", effect: "deny", resource: "docs/internal", action: "write" },
  });
  assert.equal(add.statusCode, 201);
  const { id, version } = add.json() as { id: number; version: number };

  const afterAdd = await check(["left"], "docs/internal", "write");
  assert.equal(afterAdd.allow, false, "deny rule must apply immediately");
  assert.equal(afterAdd.policyVersion, version);

  const del = await app.inject({ method: "DELETE", url: `/policy/rules/${id}` });
  assert.equal(del.statusCode, 200);
  const afterDel = await check(["left"], "docs/internal", "write");
  assert.equal(afterDel.allow, true, "removal must apply immediately");
});

test("invalid input maps to 400 with input category", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/check",
    payload: { roles: [], resource: "x", action: "y" },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error: { category: string; code: string } };
  assert.equal(body.error.category, "input");
  assert.equal(body.error.code, "INVALID_ROLES");
});

test("state conflict maps to 409 with conflict category", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/policy/rules",
    payload: { role: "ghost", effect: "allow", resource: "x", action: "y" },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json() as { error: { category: string; code: string } };
  assert.equal(body.error.category, "conflict");
  assert.equal(body.error.code, "ROLE_NOT_FOUND");
});

test("diagnostics endpoint reports version and counts", async () => {
  const res = await app.inject({ method: "GET", url: "/diagnostics/state" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { version: number; roles: number; rules: number };
  assert.ok(body.version >= 1);
  assert.equal(body.roles, 4);
});

test("decision response carries runId for log replay", async () => {
  const d = await check(["bottom"], "docs/x", "read");
  assert.ok(typeof d.runId === "string" && d.runId.length > 0);
});
