import assert from "node:assert/strict";
import { evolverIndependent } from "./oracle.js";
import { evolve } from "../src/kernel/evolve.js";
import { renderMetadata } from "../src/kernel/render.js";
import { seededData } from "../src/state/fixtures.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log("PASS  " + name);
  } catch (err) {
    console.error("FAIL  " + name);
    console.error(err);
    process.exitCode = 1;
  }
}

check("non-divisible ladder: feed 5 then 4 with threshold 7 -> level 2 xp 2 (matches oracle)", () => {
  const ladder = { thresholds: [7, 11, 17] };
  const first = evolve({ level: 1, xp: 0, consumedXp: 0 }, 5, ladder);
  assert.equal(first.level, 1);
  assert.equal(first.xp, 5);
  assert.equal(first.levelsGained, 0);
  const second = evolve({ level: first.level, xp: first.xp, consumedXp: first.consumedXp }, 4, ladder);
  assert.equal(second.level, 2);
  assert.equal(second.xp, 2);
  assert.equal(second.levelsGained, 1);
  assert.equal(second.consumedXp, 7);
  const oracle = evolverIndependent(1, 0, 0, [5, 4], [7, 11, 17]);
  assert.deepEqual(
    { level: oracle.level, xp: oracle.xp, consumedXp: oracle.consumedXp },
    { level: second.level, xp: second.xp, consumedXp: second.consumedXp },
    "kernel output must match independent arithmetic oracle",
  );
});

check("multi-level jump: feed 30 on threshold [7,11,17] -> level 3 xp 12", () => {
  const r = evolve({ level: 1, xp: 0, consumedXp: 0 }, 30, { thresholds: [7, 11, 17] });
  assert.equal(r.level, 3);
  assert.equal(r.xp, 12);
  assert.equal(r.consumedXp, 18);
  const oracle = evolverIndependent(1, 0, 0, [30], [7, 11, 17]);
  assert.deepEqual([r.level, r.xp, r.consumedXp], [oracle.level, oracle.xp, oracle.consumedXp]);
});

check("max level: reaching cap leaves zero residual xp", () => {
  const r = evolve({ level: 1, xp: 0, consumedXp: 0 }, 999, { thresholds: [7, 11, 17] });
  assert.equal(r.level, 4);
  assert.equal(r.xp, 0);
  assert.equal(r.consumedXp, 35);
});

check("ledger conservation across many feeds matches oracle", () => {
  const amounts = [3, 9, 2, 15, 1, 4, 8];
  let state = { level: 1, xp: 0, consumedXp: 0 };
  for (const a of amounts) {
    state = evolve(state, a, { thresholds: [7, 11, 17] });
  }
  const totalFed = amounts.reduce((x, y) => x + y, 0);
  assert.equal(totalFed, state.consumedXp + state.xp, "consumed + residual = fed");
  const oracle = evolverIndependent(1, 0, 0, amounts, [7, 11, 17]);
  assert.deepEqual(state, { level: oracle.level, xp: oracle.xp, consumedXp: oracle.consumedXp });
});

check("deterministic rendering: same state -> byte identical JSON", () => {
  const collection = seededData()[1];
  const view = { tokenId: "SPK-007", collectionId: "sprites", level: 2, xp: 2 };
  const a = JSON.stringify(renderMetadata(view, collection.templates));
  const b = JSON.stringify(renderMetadata(view, collection.templates));
  assert.equal(a, b);
  assert.equal(Buffer.byteLength(a, "utf8"), Buffer.byteLength(b, "utf8"));
});

check("rendering differs only in level-dependent fields after level up", () => {
  const collection = seededData()[1];
  const before = renderMetadata({ tokenId: "SPK-007", collectionId: "sprites", level: 1, xp: 5 }, collection.templates);
  const after = renderMetadata({ tokenId: "SPK-007", collectionId: "sprites", level: 2, xp: 2 }, collection.templates);
  const stableKeys = ["description", "tokenId", "collectionId"] as const;
  for (const k of stableKeys) assert.equal(before[k], after[k], k + " must be stable");
  assert.notEqual(before.name, after.name);
  assert.notEqual(before.image, after.image);
  const beforeTier = before.attributes.find((a) => a.trait_type === "Tier")!.value;
  const afterTier = after.attributes.find((a) => a.trait_type === "Tier")!.value;
  assert.notEqual(beforeTier, afterTier);
  const changed = Object.keys(before).filter(
    (k) => JSON.stringify((before as Record<string, unknown>)[k]) !==
           JSON.stringify((after as Record<string, unknown>)[k]),
  );
  assert.deepEqual(changed.sort(), ["attributes", "image", "name"].sort());
});

check("metadata contains no time/random/request artifacts (stable keys only)", () => {
  const collection = seededData()[0];
  const md = renderMetadata({ tokenId: "TKN-001", collectionId: "heroes", level: 1, xp: 0 }, collection.templates);
  const allowed = new Set(["name", "description", "image", "tokenId", "collectionId", "attributes"]);
  for (const k of Object.keys(md)) assert.ok(allowed.has(k), "unexpected key " + k);
});

console.log("\n" + passed + " unit checks passed");
if (process.exitCode) process.exit(process.exitCode);

