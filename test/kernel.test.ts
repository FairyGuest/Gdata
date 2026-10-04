import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, patternMatches, roleClosure } from "../src/kernel/engine.ts";
import type { PolicySnapshot } from "../src/contract/types.ts";

function snap(partial: Partial<PolicySnapshot>): PolicySnapshot {
  return { version: 1, roles: new Map(), rules: [], ...partial };
}

// Diamond: root <- left,right <- bottom
const diamondRoles = new Map<string, string[]>([
  ["bottom", ["left", "right"]],
  ["left", ["root"]],
  ["right", ["root"]],
  ["root", []],
]);

test("diamond inheritance: shared ancestor appears exactly once", () => {
  const closure = roleClosure(diamondRoles, ["bottom"]);
  assert.deepEqual([...closure].sort(), ["bottom", "left", "right", "root"]);
});

test("diamond inheritance: inherited allow rule applies via both paths, deduplicated", () => {
  const s = snap({
    roles: diamondRoles,
    rules: [{ id: 1, role: "root", effect: "allow", resource: "docs/readme", action: "read" }],
  });
  const d = decide(s, { roles: ["bottom"], resource: "docs/readme", action: "read" });
  assert.equal(d.allow, true);
  assert.equal(d.reason, "ALLOW_RULE_MATCHED");
  assert.equal(d.matchedRules.length, 1, "shared ancestor rule must not be counted twice");
});

test("deny overrides allow on same resource+action", () => {
  const s = snap({
    roles: diamondRoles,
    rules: [
      { id: 1, role: "left", effect: "allow", resource: "docs/internal", action: "write" },
      { id: 2, role: "right", effect: "deny", resource: "docs/internal", action: "write" },
    ],
  });
  const d = decide(s, { roles: ["bottom"], resource: "docs/internal", action: "write" });
  assert.equal(d.allow, false);
  assert.equal(d.reason, "DENY_RULE_MATCHED");
  assert.equal(d.matchedRules.length, 2);
});

test("wildcard resource pattern covers all actions under prefix", () => {
  assert.equal(patternMatches("docs/*", "docs/read"), true);
  assert.equal(patternMatches("docs/*", "docs/a/b/c"), true);
  assert.equal(patternMatches("docs/*", "docs"), false);
  assert.equal(patternMatches("docs/*", "docsx/read"), false);
  assert.equal(patternMatches("*", "anything"), true);
  assert.equal(patternMatches("docs/read", "docs/read"), true);
  assert.equal(patternMatches("docs/read", "docs/write"), false);
});

test("wildcard rule grants inherited access to nested resource", () => {
  const s = snap({
    roles: diamondRoles,
    rules: [{ id: 1, role: "root", effect: "allow", resource: "docs/*", action: "read" }],
  });
  const d = decide(s, { roles: ["bottom"], resource: "docs/team/plan", action: "read" });
  assert.equal(d.allow, true);
  const d2 = decide(s, { roles: ["bottom"], resource: "docs/team/plan", action: "delete" });
  assert.equal(d2.allow, false);
  assert.equal(d2.reason, "NO_RULE_MATCHED");
});

test("default deny when no rule matches", () => {
  const d = decide(snap({ roles: diamondRoles }), {
    roles: ["bottom"],
    resource: "secret",
    action: "read",
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, "NO_RULE_MATCHED");
});

test("subject with unknown role still gets default deny, not an error", () => {
  const d = decide(snap({}), { roles: ["ghost"], resource: "x", action: "y" });
  assert.equal(d.allow, false);
  assert.deepEqual(d.effectiveRoles, ["ghost"]);
});
