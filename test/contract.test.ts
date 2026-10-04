import { test } from "node:test";
import assert from "node:assert/strict";
import { RbacError } from "../src/contract/errors.ts";
import { parseCheckRequest, parsePolicyDocument, parseRule } from "../src/contract/validate.ts";

function expectInputError(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof RbacError, "must be RbacError");
    assert.equal(e.category, "input");
    assert.equal(e.code, code);
    return true;
  });
}

test("valid check request parses", () => {
  const r = parseCheckRequest({ roles: ["a"], resource: "docs/x", action: "read" });
  assert.deepEqual(r, { roles: ["a"], resource: "docs/x", action: "read" });
});

test("check request rejects empty roles", () => {
  expectInputError(() => parseCheckRequest({ roles: [], resource: "r", action: "a" }), "INVALID_ROLES");
});

test("check request rejects non-object body", () => {
  expectInputError(() => parseCheckRequest("nope"), "INVALID_BODY");
  expectInputError(() => parseCheckRequest(null), "INVALID_BODY");
});

test("check request rejects duplicate roles", () => {
  expectInputError(
    () => parseCheckRequest({ roles: ["a", "a"], resource: "r", action: "x" }),
    "INVALID_ROLES",
  );
});

test("rule rejects invalid effect", () => {
  expectInputError(
    () => parseRule({ role: "a", effect: "maybe", resource: "r", action: "x" }),
    "INVALID_EFFECT",
  );
});

test("rule rejects mid-string wildcard", () => {
  expectInputError(
    () => parseRule({ role: "a", effect: "allow", resource: "docs/*/x", action: "read" }),
    "INVALID_PATTERN",
  );
});

test("policy document rejects inheritance self-loop", () => {
  expectInputError(
    () => parsePolicyDocument({ roles: [{ role: "a", parent: "a" }], rules: [] }),
    "SELF_INHERITANCE",
  );
});
