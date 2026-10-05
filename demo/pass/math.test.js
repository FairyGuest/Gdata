import assert from "node:assert/strict";

export const tests = {
  "addition works": () => {
    assert.equal(1 + 1, 2);
  },
  "async case works": async () => {
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(true);
  },
};
