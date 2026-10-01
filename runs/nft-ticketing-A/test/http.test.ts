import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppContext } from "../src/app.ts";

let ctx: AppContext;

test.before(async () => {
  ctx = buildApp(":memory:");
  await ctx.app.ready();
});

test.after(() => {
  ctx.ledger.close();
});

test("422 on malformed input with distinguishable reason", async () => {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/tickets/purchase",
    payload: { runId: "r", seq: 1, sessionId: "S1", seatCode: "A-1" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { reason: string } };
  assert.equal(body.error.reason, "missing_field");
});

test("422 unknown seat", async () => {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/tickets/purchase",
    payload: { runId: "r", seq: 1, sessionId: "S1", seatCode: "ZZZ", userId: "alice" },
  });
  assert.equal(res.statusCode, 422);
  assert.equal((res.json() as { error: { reason: string } }).error.reason, "unknown_seat");
});

test("purchase then conflicting purchase returns 409 seat_taken", async () => {
  const first = await ctx.app.inject({
    method: "POST",
    url: "/tickets/purchase",
    payload: { runId: "http", seq: 1, sessionId: "S1", seatCode: "A-1", userId: "alice" },
  });
  assert.equal(first.statusCode, 200);

  const second = await ctx.app.inject({
    method: "POST",
    url: "/tickets/purchase",
    payload: { runId: "http", seq: 2, sessionId: "S1", seatCode: "A-1", userId: "bob" },
  });
  assert.equal(second.statusCode, 409);
  const body = second.json() as { result: { reason: string } };
  assert.equal(body.result.reason, "seat_taken");
});

test("diagnostics expose ticket state and history", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/diag/tickets/S1%3AA-1%23g1" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ticket: { holderUserId: string; status: string };
    history: Array<{ action: string }>;
  };
  assert.equal(body.ticket.holderUserId, "alice");
  assert.ok(body.history.some((h) => h.action === "issue"));
});


