import test from "node:test";
import assert from "node:assert/strict";
import { matchPattern } from "../src/core/glob.ts";
import { decide } from "../src/core/engine.ts";
import { AppError } from "../src/contract/errors.ts";
import type { Snapshot } from "../src/contract/types.ts";

const OPTS = { maxInheritanceDepth: 32, newRunId: () => "run-test" };

// Diamond inheritance:
//        base
//       /    \
//    left    right
//       \    /
//       grand
// grand inherits left+right; both inherit base. base perms must not be
// double-counted (matched rules deduplicated by role set).
function diamondSnapshot(): Snapshot {
  return {
    version: 1,
    roles: [
      { name: "base", inherits: [] },
      { name: "left", inherits: ["base"] },
      { name: "right", inherits: ["base"] },
      { name: "grand", inherits: ["left", "right"] },
    ],
    policies: [
      { id: "p-base-read", role: "base", resource: "docs/*", action: "read", effect: "allow" },
      { id: "p-left-write", role: "left", resource: "docs/draft", action: "write", effect: "allow" },
      { id: "p-right-deny", role: "right", resource: "docs/secret", action: "read", effect: "deny" },
    ],
  };
}

test("diamond inheritance: grand gets all ancestor permissions, deduplicated", () => {
  const d = decide(
    { subject: { roles: ["grand"] }, resource: "docs/readme", action: "read" },
    diamondSnapshot(),
    OPTS,
  );
  assert.equal(d.allowed, true);
  assert.deepEqual(d.expandedRoles, ["base", "grand", "left", "right"]);
  // base matched exactly once despite two inheritance paths
  assert.equal(d.matched.filter((m) => m.policyId === "p-base-read").length, 1);
});

test("diamond inheritance: permission from one branch only", () => {
  const d = decide(
    { subject: { roles: ["grand"] }, resource: "docs/draft", action: "write" },
    diamondSnapshot(),
    OPTS,
  );
  assert.equal(d.allowed, true);
  assert.deepEqual(d.matched.map((m) => m.policyId), ["p-left-write"]);
});

test("deny overrides allow on same resource+action", () => {
  const snap = diamondSnapshot();
  const d = decide(
    { subject: { roles: ["grand"] }, resource: "docs/secret", action: "read" },
    snap,
    OPTS,
  );
  // p-base-read allows docs/* read, p-right-deny denies docs/secret read
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => r.startsWith("deny overrides allow")));
  assert.deepEqual(
    d.matched.map((m) => m.policyId).sort(),
    ["p-base-read", "p-right-deny"],
  );
});

test("default deny when nothing matches", () => {
  const d = decide(
    { subject: { roles: ["grand"] }, resource: "admin/panel", action: "read" },
    diamondSnapshot(),
    OPTS,
  );
  assert.equal(d.allowed, false);
  assert.deepEqual(d.reasons, ["default deny: no rule matched"]);
});

test("wildcard matching semantics", () => {
  assert.equal(matchPattern("docs/*", "docs/read"), true);
  assert.equal(matchPattern("docs/*", "docs/a/b"), false);
  assert.equal(matchPattern("docs/**", "docs/a/b"), true);
  assert.equal(matchPattern("docs/**", "docs"), true);
  assert.equal(matchPattern("*", "docs"), true);
  assert.equal(matchPattern("*", "docs/read"), false);
  assert.equal(matchPattern("docs/read", "docs/read"), true);
  assert.equal(matchPattern("docs/read", "docs/write"), false);
});

test("unknown role in request raises STATE_CONFLICT", () => {
  assert.throws(
    () =>
      decide(
        { subject: { roles: ["ghost"] }, resource: "docs/x", action: "read" },
        diamondSnapshot(),
        OPTS,
      ),
    (err: unknown) => err instanceof AppError && err.category === "STATE_CONFLICT",
  );
});

test("inheritance cycle raises STATE_CONFLICT", () => {
  const snap: Snapshot = {
    version: 1,
    roles: [
      { name: "a", inherits: ["b"] },
      { name: "b", inherits: ["a"] },
    ],
    policies: [],
  };
  assert.throws(
    () => decide({ subject: { roles: ["a"] }, resource: "x", action: "y" }, snap, OPTS),
    (err: unknown) => err instanceof AppError && err.category === "STATE_CONFLICT",
  );
});

