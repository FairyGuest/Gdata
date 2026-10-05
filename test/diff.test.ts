import { test } from "node:test";
import assert from "node:assert/strict";
import { diffValues } from "../src/core/diff.ts";
import { isIgnored, matchesPath } from "../src/core/ignore.ts";

test("nested object change is located at exact path", () => {
  const before = { user: { name: "ann", address: { city: "beijing", zip: "100000" } } };
  const after = { user: { name: "ann", address: { city: "shanghai", zip: "100000" } } };
  const { entries, truncated } = diffValues(before, after, 100);
  assert.equal(truncated, false);
  assert.deepEqual(entries, [
    { path: "user.address.city", kind: "changed", before: "beijing", after: "shanghai" },
  ]);
});

test("added and removed object fields are reported separately", () => {
  const before = { a: 1, gone: true };
  const after = { a: 1, fresh: "x" };
  const { entries } = diffValues(before, after, 100);
  assert.deepEqual(entries, [
    { path: "gone", kind: "removed", before: true },
    { path: "fresh", kind: "added", after: "x" },
  ]);
});

test("array element removal and addition are detected by index", () => {
  const before = { items: [1, 2, 3] };
  const after = { items: [1, 2] };
  const removed = diffValues(before, after, 100).entries;
  assert.deepEqual(removed, [{ path: "items[2]", kind: "removed", before: 3 }]);

  const added = diffValues(after, before, 100).entries;
  assert.deepEqual(added, [{ path: "items[2]", kind: "added", after: 3 }]);
});

test("array element modification inside nested objects", () => {
  const before = { users: [{ id: 1, role: "admin" }, { id: 2, role: "user" }] };
  const after = { users: [{ id: 1, role: "admin" }, { id: 2, role: "owner" }] };
  const { entries } = diffValues(before, after, 100);
  assert.deepEqual(entries, [
    { path: "users[1].role", kind: "changed", before: "user", after: "owner" },
  ]);
});

test("type change at same path is a changed entry", () => {
  const { entries } = diffValues({ v: [1] }, { v: "1" }, 100);
  assert.deepEqual(entries, [{ path: "v", kind: "changed", before: [1], after: "1" }]);
});

test("diff is truncated at maxEntries and flagged", () => {
  const before = { a: 1, b: 2, c: 3 };
  const after = { a: 10, b: 20, c: 30 };
  const { entries, truncated } = diffValues(before, after, 2);
  assert.equal(entries.length, 2);
  assert.equal(truncated, true);
});

test("identical payloads produce no diff", () => {
  const v = { a: [1, { b: "c" }], d: null };
  const { entries } = diffValues(v, JSON.parse(JSON.stringify(v)), 100);
  assert.deepEqual(entries, []);
});

test("ignore path matching: exact, wildcard, array index", () => {
  assert.equal(matchesPath("meta.timestamp", "meta.timestamp"), true);
  assert.equal(matchesPath("meta.timestamp", "meta.other"), false);
  assert.equal(matchesPath("items[*].updatedAt", "items[3].updatedAt"), true);
  assert.equal(matchesPath("items[*].updatedAt", "items[3].id"), false);
  assert.equal(matchesPath("items[0].id", "items[0].id"), true);
  assert.equal(isIgnored(["meta.timestamp"], "meta.timestamp"), true);
  assert.equal(isIgnored(["meta.timestamp"], "meta"), false);
});
