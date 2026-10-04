import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFeed, maxLevel } from "../src/kernel/evolve.js";
import { renderMetadata, type CollectionTemplate } from "../src/kernel/render.js";

const LADDER = [7, 10, 15];

// Reference arithmetic written independently of the kernel implementation.
function referenceFeed(level: number, xp: number, amount: number) {
  const costs = [7, 10, 15];
  let remaining = xp + amount;
  let lvl = level;
  while (lvl <= 3 && remaining >= costs[lvl - 1]) {
    remaining -= costs[lvl - 1];
    lvl++;
  }
  return { level: lvl, xp: remaining };
}

test("non-divisible ladder: feed 5 then 4 -> level 2, xp 2", () => {
  const first = applyFeed({ level: 1, xp: 0, thresholds: LADDER, amount: 5 });
  assert.deepEqual({ level: first.level, xp: first.xp }, { level: 1, xp: 5 });
  const second = applyFeed({ level: first.level, xp: first.xp, thresholds: LADDER, amount: 4 });
  assert.equal(second.level, 2);
  assert.equal(second.xp, 2);
  assert.equal(second.consumed, 7);
  assert.equal(second.transitions, 1);
  // independent cross-check
  const ref = referenceFeed(1, 0, 9);
  assert.equal(second.level, ref.level);
  assert.equal(second.xp, ref.xp);
});

test("multi-level jump consumes each threshold and carries remainder", () => {
  const r = applyFeed({ level: 1, xp: 0, thresholds: LADDER, amount: 20 });
  // 7 + 10 = 17 consumed, remainder 3 at level 3
  assert.deepEqual({ level: r.level, xp: r.xp, consumed: r.consumed, transitions: r.transitions },
    { level: 3, xp: 3, consumed: 17, transitions: 2 });
  assert.deepEqual(referenceFeed(1, 0, 20), { level: 3, xp: 3 });
});

test("max level: feed reports alreadyMax and consumes nothing", () => {
  assert.equal(maxLevel(LADDER), 4);
  const r = applyFeed({ level: 4, xp: 0, thresholds: LADDER, amount: 100 });
  assert.equal(r.alreadyMax, true);
  assert.equal(r.consumed, 0);
});

test("reaching max level keeps leftover xp as balance (ledger conserved)", () => {
  const r = applyFeed({ level: 1, xp: 0, thresholds: LADDER, amount: 40 });
  // 7+10+15 = 32 consumed, 8 left at max level 4
  assert.deepEqual({ level: r.level, xp: r.xp, consumed: r.consumed }, { level: 4, xp: 8, consumed: 32 });
});

const TEMPLATE: CollectionTemplate = {
  collectionId: "dragons",
  baseName: "Dragon",
  staticAttributes: [{ trait_type: "Background", value: "forest" }],
  levels: [
    { tier: "bronze", image: "ipfs://x/1.png" },
    { tier: "silver", image: "ipfs://x/2.png" },
  ],
};

test("render is deterministic: byte-identical across renders", () => {
  const a = renderMetadata(TEMPLATE, 1, 1, 5);
  const b = renderMetadata(TEMPLATE, 1, 1, 5);
  assert.equal(a, b);
});

test("level-up changes exactly name/tier/image/level fields", () => {
  const before = JSON.parse(renderMetadata(TEMPLATE, 1, 1, 5));
  const after = JSON.parse(renderMetadata(TEMPLATE, 1, 2, 2));
  assert.notEqual(before.name, after.name);
  assert.notEqual(before.tier, after.tier);
  assert.notEqual(before.image, after.image);
  assert.equal(after.level, 2);
  // level-independent attribute stays identical
  assert.deepEqual(
    before.attributes.find((a: any) => a.trait_type === "Background"),
    after.attributes.find((a: any) => a.trait_type === "Background"),
  );
});
