import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyStore } from "../src/state/store.ts";
import { RbacError } from "../src/contract/errors.ts";

function expectConflict(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof RbacError);
    assert.equal(e.category, "conflict");
    assert.equal(e.code, code);
    return true;
  });
}

test("snapshot reflects committed state with monotonic version", () => {
  const s = new PolicyStore();
  assert.equal(s.getSnapshot().version, 0);
  s.replacePolicy({
    roles: [{ role: "a", parent: "b" }],
    rules: [{ role: "b", effect: "allow", resource: "x", action: "y" }],
  });
  const snap = s.getSnapshot();
  assert.equal(snap.version, 1);
  assert.deepEqual(snap.roles.get("a"), ["b"]);
  assert.equal(snap.rules.length, 1);
  s.close();
});

test("failed replacePolicy leaves previous state fully intact (atomicity)", () => {
  const s = new PolicyStore();
  s.replacePolicy({ roles: [{ role: "a", parent: "b" }], rules: [] });
  const before = s.getSnapshot();
  // cyclic document must be rejected and rolled back
  expectConflict(
    () =>
      s.replacePolicy({
        roles: [
          { role: "x", parent: "y" },
          { role: "y", parent: "x" },
        ],
        rules: [],
      }),
    "INHERITANCE_CYCLE",
  );
  const after = s.getSnapshot();
  assert.equal(after.version, before.version);
  assert.deepEqual([...after.roles.keys()].sort(), [...before.roles.keys()].sort());
  s.close();
});

test("addRoleEdge rejects cycles", () => {
  const s = new PolicyStore();
  s.replacePolicy({ roles: [{ role: "a", parent: "b" }], rules: [] });
  expectConflict(() => s.addRoleEdge({ role: "b", parent: "a" }), "INHERITANCE_CYCLE");
  s.close();
});

test("duplicate role and edge raise conflict errors", () => {
  const s = new PolicyStore();
  s.replacePolicy({ roles: [{ role: "a", parent: "b" }], rules: [] });
  expectConflict(() => s.addRole("a"), "ROLE_EXISTS");
  expectConflict(() => s.addRoleEdge({ role: "a", parent: "b" }), "EDGE_EXISTS");
  s.close();
});

test("rule referencing unknown role is a conflict; deleting missing rule too", () => {
  const s = new PolicyStore();
  s.replacePolicy({ roles: [], rules: [] });
  expectConflict(
    () => s.addRule({ role: "ghost", effect: "allow", resource: "r", action: "a" }),
    "ROLE_NOT_FOUND",
  );
  expectConflict(() => s.deleteRule(999), "RULE_NOT_FOUND");
  s.close();
});

test("hot update: snapshot before update unchanged, new snapshot reflects update", () => {
  const s = new PolicyStore();
  s.replacePolicy({
    roles: [],
    rules: [],
  });
  s.addRole("r1");
  const before = s.getSnapshot();
  const { id } = s.addRule({ role: "r1", effect: "allow", resource: "docs/*", action: "read" });
  const after = s.getSnapshot();
  assert.equal(after.version, before.version + 1);
  assert.equal(before.rules.length, 0, "old snapshot must stay immutable");
  assert.equal(after.rules.length, 1);
  s.deleteRule(id);
  assert.equal(s.getSnapshot().rules.length, 0);
  s.close();
});
