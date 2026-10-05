import assert from "node:assert/strict";

export const tests = {
  "this one passes": () => {
    assert.equal(2 * 2, 4);
  },
  "this one fails": () => {
    assert.equal(2 + 2, 5, "arithmetic is broken on purpose");
  },
};
