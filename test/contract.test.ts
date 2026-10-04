import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";

test("contract: invalid inputs map to 422 with distinct reasons", async () => {
  const { app } = buildApp();
  const cases: Array<[unknown, string]> = [
    [{ borrower: "alice", tokenId: "nft-1", amount: -5, perTickBps: 5 }, "invalid_amount"],
    [{ borrower: "alice", tokenId: "nft-1", amount: 100, perTickBps: 10001 }, "invalid_bps"],
    [{ borrower: "alice", tokenId: "nft-1", amount: 100, perTickBps: -1 }, "invalid_bps"],
    [{ borrower: "", tokenId: "nft-1", amount: 100, perTickBps: 5 }, "invalid_field"],
    [["not-an-object"], "invalid_body"],
  ];
  for (const [body, reason] of cases) {
    const res = await app.inject({ method: "POST", url: "/borrow", payload: body as object });
    assert.equal(res.statusCode, 422, JSON.stringify(body));
    assert.equal(res.json().reason, reason);
  }
  await app.close();
});
