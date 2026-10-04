import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type App } from "../src/server.js";
import { defaultConfig } from "../src/config.js";

let ctx: App;
before(() => {
  ctx = buildApp({ ...defaultConfig, dbPath: ":memory:" });
});
after(() => ctx.app.close());

test("concurrent double feed: both 200, no lost update, ledger conserved", async () => {
  const [r1, r2] = await Promise.all([
    ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 1, amount: 4 } }),
    ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 1, amount: 5 } }),
  ]);
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  const seqs = [r1.json().commitSeq, r2.json().commitSeq];
  assert.notEqual(seqs[0], seqs[1], "commit sequences must serialize the two feeds");
  const ledger = (await ctx.app.inject({ method: "GET", url: "/diag/tokens/1/ledger" })).json();
  // 4 + 5 = 9 fed; threshold 7 consumed once; xp balance 2; level 2
  assert.equal(ledger.total_fed, 9);
  assert.equal(ledger.total_consumed, 7);
  assert.equal(ledger.xp, 2);
  assert.equal(ledger.level, 2);
  assert.equal(ledger.total_fed, ledger.total_consumed + ledger.xp, "ledger conservation");
});

test("metadata deterministic and reflects level", async () => {
  const m1 = await ctx.app.inject({ method: "GET", url: "/tokens/1/metadata" });
  const m2 = await ctx.app.inject({ method: "GET", url: "/tokens/1/metadata" });
  assert.equal(m1.body, m2.body, "byte-identical render");
  assert.equal(m1.json().level, 2);
  assert.equal(m1.json().tier, "silver");
});

test("reset requires collection admin; reset returns to level 1 xp 0", async () => {
  const forbidden = await ctx.app.inject({
    method: "POST", url: "/reset", payload: { tokenId: 1 }, headers: { "x-admin-id": "intruder" },
  });
  assert.equal(forbidden.statusCode, 422);
  assert.equal(forbidden.json().error.reason, "not_collection_admin");

  const ok = await ctx.app.inject({
    method: "POST", url: "/reset", payload: { tokenId: 1 }, headers: { "x-admin-id": "admin-1" },
  });
  assert.equal(ok.statusCode, 200);
  const meta = (await ctx.app.inject({ method: "GET", url: "/tokens/1/metadata" })).json();
  assert.equal(meta.level, 1);
  assert.equal(meta.xp, 0);
  assert.equal(meta.tier, "bronze");
});

test("max level then feed -> 409 max_level_reached", async () => {
  const big = await ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 2, amount: 40 } });
  assert.equal(big.statusCode, 200);
  assert.equal(big.json().level, 4);
  const again = await ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 2, amount: 1 } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.reason, "max_level_reached");
});

test("input/state/resource error categories are distinguishable", async () => {
  const badXp = await ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 1, amount: -3 } });
  assert.equal(badXp.statusCode, 422);
  assert.equal(badXp.json().error.reason, "invalid_xp_amount");

  const missing = await ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 999, amount: 1 } });
  assert.equal(missing.statusCode, 422);
  assert.equal(missing.json().error.reason, "token_not_found");

  const huge = await ctx.app.inject({ method: "POST", url: "/feed", payload: { tokenId: 1, amount: 2_000_000 } });
  assert.equal(huge.statusCode, 503);
  assert.equal(huge.json().error.reason, "feed_amount_exceeds_capacity");
});
