import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLayers, validateLayer } from "../src/core/merge.ts";
import { AppError } from "../src/contracts/errors.ts";
import type { LayerSet } from "../src/contracts/types.ts";

function layers(base: unknown, env: unknown, instance: unknown): LayerSet {
  return { base, env, instance } as LayerSet;
}

test("deep merge: nested objects recurse to leaves", () => {
  const { effective } = mergeLayers(layers(
    { a: { x: 1, y: 2 }, keep: "base" },
    { a: { y: 20, z: 30 } },
    { a: { z: 300 } },
  ));
  assert.deepEqual(effective, { a: { x: 1, y: 20, z: 300 }, keep: "base" });
});

test("arrays are replaced wholesale, not element-merged", () => {
  const { effective } = mergeLayers(layers(
    { list: [1, 2, 3], other: "x" },
    { list: [9] },
    {},
  ));
  assert.deepEqual(effective, { list: [9], other: "x" });
});

test("null acts as a deletion marker and removes the key", () => {
  const { effective } = mergeLayers(layers(
    { doomed: "value", nested: { gone: 1, stay: 2 } },
    { doomed: null },
    { nested: { gone: null } },
  ));
  assert.deepEqual(effective, { nested: { stay: 2 } });
  assert.ok(!("doomed" in effective));
  assert.ok(!("gone" in (effective["nested"] as Record<string, unknown>)));
});

test("scalar override: later layer wins", () => {
  const { effective } = mergeLayers(layers({ n: 1 }, { n: 2 }, { n: 3 }));
  assert.deepEqual(effective, { n: 3 });
});

test("rejects a non-object layer and names the layer", () => {
  assert.throws(
    () => mergeLayers(layers([1, 2], {}, {})),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.category, "INPUT_ERROR");
      assert.equal(err.detail["layer"], "base");
      assert.match(err.message, /layer "base"/);
      return true;
    },
  );
});

test("rejects empty-string keys with layer and position", () => {
  assert.throws(
    () => mergeLayers(layers({}, { outer: { "": 1 } }, {})),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.category, "INPUT_ERROR");
      assert.equal(err.detail["layer"], "env");
      assert.equal(err.detail["path"], "outer");
      return true;
    },
  );
});

test("validateLayer rejects scalar layer", () => {
  assert.throws(() => validateLayer("instance", 42), /layer "instance" must be a JSON object/);
});
