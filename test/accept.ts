import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createContext } from "../src/main.js";
import { evolverIndependent } from "./oracle.js";

interface HttpResponse { status: number; body: any; payload: string; }

class Harness {
  failures: string[] = [];
  scenarioNo = 0;
  constructor(public app: Awaited<ReturnType<typeof createContext>>["app"], public runId: string) {}

  async request(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse> {
    const res = await this.app.inject({ method: method as "GET" | "POST", url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...(headers ?? {}) } });
    let parsed: any = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
    return { status: res.statusCode, body: parsed, payload: res.body };
  }
  scenario(name: string): void { this.scenarioNo += 1; console.log("\n[SCENARIO " + this.scenarioNo + "] " + name); }
  check(name: string, cond: boolean, reason: string): void {
    if (cond) { console.log("    [PASS] " + name + "  (" + reason + ")"); }
    else { console.log("    [FAIL] " + name + "  (" + reason + ")"); this.failures.push("S" + this.scenarioNo + ": " + name); }
  }
  expect(name: string, actual: unknown, expected: unknown): void {
    let ok = false;
    try { assert.deepStrictEqual(actual, expected); ok = true; } catch { ok = false; }
    this.check(name, ok, "expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
  }
}

async function main(): Promise<void> {
  const runId = "accept-" + randomUUID();
  const { app, ctx } = createContext(":memory:", runId);
  const h = new Harness(app, runId);
  console.log("RUN_ID = " + runId + "  (events tagged with this id for replay/diagnostics)");

  h.scenario("fixture sanity: deterministic seed, fresh token at level 1 / xp 0");
  const health = await h.request("GET", "/healthz");
  h.expect("healthz 200 echoes run id", { status: health.status, runId: health.body.runId }, { status: 200, runId });
  const t0 = await h.request("GET", "/diag/token/sprites/SPK-007");
  h.expect("fresh token level/xp/consumed", { l: t0.body.status.level, x: t0.body.status.xp, c: t0.body.status.consumedXp }, { l: 1, x: 0, c: 0 });

  h.scenario("non-divisible ladder: threshold 7, feed 5 then 4 -> +1 level, xp carry 2");
  const f5Req = { collectionId: "sprites", tokenId: "SPK-007", amount: 5 };
  console.log("    REQUEST POST /feed " + JSON.stringify(f5Req));
  const f5 = await h.request("POST", "/feed", f5Req);
  console.log("    RESPONSE " + f5.status + " " + f5.payload);
  h.expect("feed 5 -> level 1 xp 5", [f5.status, f5.body.level, f5.body.xp, f5.body.levelsGained], [200, 1, 5, 0]);
  const f4Req = { collectionId: "sprites", tokenId: "SPK-007", amount: 4 };
  console.log("    REQUEST POST /feed " + JSON.stringify(f4Req));
  const f4 = await h.request("POST", "/feed", f4Req);
  console.log("    RESPONSE " + f4.status + " " + f4.payload);
  h.expect("feed 4 -> level 2 xp 2 gained 1", [f4.status, f4.body.level, f4.body.xp, f4.body.levelsGained], [200, 2, 2, 1]);
  const oracle2 = evolverIndependent(1, 0, 0, [5, 4], [7, 11, 17]);
  h.expect("matches independent arithmetic oracle", [f4.body.level, f4.body.xp, f4.body.consumedXp], [oracle2.level, oracle2.xp, oracle2.consumedXp]);

  h.scenario("deterministic server-side rendering; upgrade diff is only level-dependent");
  const mUpgradedA = await h.request("GET", "/metadata/sprites/SPK-007");
  const mUpgradedB = await h.request("GET", "/metadata/sprites/SPK-007");
  h.check("same state renders byte-identical", mUpgradedA.payload === mUpgradedB.payload, "bytes=" + Buffer.byteLength(mUpgradedA.payload));
  console.log("    METADATA(level2) " + mUpgradedA.payload);
  const before = mUpgradedA.body;
  const resetNow = await h.request("POST", "/reset", { collectionId: "sprites", tokenId: "SPK-007" }, { "x-admin-id": "admin-bob" });
  console.log("    REQUEST POST /reset (admin-bob) -> " + resetNow.status + " " + resetNow.payload);
  const after = (await h.request("GET", "/metadata/sprites/SPK-007")).body;
  const changedKeys = Object.keys(before).filter((k: string) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
  h.expect("changed keys are exactly name/image/attributes", changedKeys, ["attributes", "image", "name"].sort());
  h.check("identity fields stable", before.description === after.description && before.tokenId === after.tokenId && before.collectionId === after.collectionId, "description/tokenId/collectionId unchanged");
  const forbidden = /"(timestamp|time|date|random|nonce|requestId|request_id)"/;
  h.check("no time/random/request fields in metadata", forbidden.test(mUpgradedA.payload) === false, "schema key whitelist");

  h.scenario("concurrent double feed heroes/TKN-001 (25 || 30): both commit, no lost update, ledger conserved");
  const aReq = { collectionId: "heroes", tokenId: "TKN-001", amount: 25 };
  const bReq = { collectionId: "heroes", tokenId: "TKN-001", amount: 30 };
  console.log("    CONCURRENT REQUESTS " + JSON.stringify(aReq) + "  ||  " + JSON.stringify(bReq));
  const [ra, rb] = await Promise.all([h.request("POST", "/feed", aReq), h.request("POST", "/feed", bReq)]);
  console.log("    RESPONSE A " + ra.status + " " + ra.payload);
  console.log("    RESPONSE B " + rb.status + " " + rb.payload);
  h.check("both feeds HTTP 200", ra.status === 200 && rb.status === 200, ra.status + "/" + rb.status);
  h.check("distinct commit seq (serialized, not last-write-wins)", ra.body.seq !== rb.body.seq, "seqA=" + ra.body.seq + " seqB=" + rb.body.seq);
  const history = await h.request("GET", "/diag/history/heroes/TKN-001");
  console.log("    FEED_HISTORY " + JSON.stringify(history.body.feeds));
  console.log("    LEVEL_HISTORY " + JSON.stringify(history.body.levels));
  h.expect("both amounts persisted (sorted view)", history.body.feeds.map((e: any) => e.amount).sort((x: number, y: number) => x - y), [25, 30]);
  const ledger = history.body.ledger;
  h.check("ledger conserved: 55 = consumed + xp", ledger.balanced === true && ledger.totalFed === 55 && ledger.totalFed === ledger.totalConsumed + ledger.currentXp, JSON.stringify(ledger));
  const oracleC = evolverIndependent(1, 0, 0, [25, 30], [10, 20, 40, 80]);
  const fs4 = (await h.request("GET", "/diag/token/heroes/TKN-001")).body.status;
  h.expect("final level/xp matches oracle", [fs4.level, fs4.xp, fs4.consumedXp], [oracleC.level, oracleC.xp, oracleC.consumedXp]);
  h.expect("specific result: level 3, xp 25, consumed 30", [fs4.level, fs4.xp, fs4.consumedXp], [3, 25, 30]);

  h.scenario("reset is admin-only and immediately reflected in metadata");
  const badReset = await h.request("POST", "/reset", { collectionId: "heroes", tokenId: "TKN-001" }, { "x-admin-id": "admin-bob" });
  h.expect("foreign admin -> 409 not_collection_admin", [badReset.status, badReset.body.reason], [409, "not_collection_admin"]);
  const noCred = await h.request("POST", "/reset", { collectionId: "heroes", tokenId: "TKN-001" });
  h.expect("missing credential -> 422 missing_admin_credentials", [noCred.status, noCred.body.reason], [422, "missing_admin_credentials"]);
  const goodReset = await h.request("POST", "/reset", { collectionId: "heroes", tokenId: "TKN-001" }, { "x-admin-id": "admin-alice" });
  h.expect("collection admin reset -> level 1 xp 0", [goodReset.status, goodReset.body.level, goodReset.body.xp], [200, 1, 0]);
  const postMeta = (await h.request("GET", "/metadata/heroes/TKN-001")).body;
  h.expect("metadata immediately shows level 1 xp 0", [postMeta.attributes.find((a: any) => a.trait_type === "Level").value, postMeta.attributes.find((a: any) => a.trait_type === "XP").value], [1, 0]);

  h.scenario("reaching max level then feeding again -> 409 max_level_reached");
  const reach = await h.request("POST", "/feed", { collectionId: "heroes", tokenId: "TKN-002", amount: 150 });
  h.expect("feed 150 (10+20+40+80) -> level 5 xp 0", [reach.status, reach.body.level, reach.body.xp, reach.body.levelsGained], [200, 5, 0, 4]);
  const over = await h.request("POST", "/feed", { collectionId: "heroes", tokenId: "TKN-002", amount: 1 });
  h.expect("further feed -> 409 max_level_reached", [over.status, over.body.reason], [409, "max_level_reached"]);
  const unchanged = (await h.request("GET", "/diag/token/heroes/TKN-002")).body.status;
  h.expect("rejected feed did not mutate state", [unchanged.level, unchanged.xp], [5, 0]);

  h.scenario("error taxonomy: distinguishable 422 / 409 / 503 / 500 reasons");
  const neg = await h.request("POST", "/feed", { collectionId: "heroes", tokenId: "TKN-001", amount: -3 });
  h.expect("negative amount -> 422 xp_amount_not_positive", [neg.status, neg.body.reason], [422, "xp_amount_not_positive"]);
  const frac = await h.request("POST", "/feed", { collectionId: "heroes", tokenId: "TKN-001", amount: 2.5 });
  h.expect("fractional amount -> 422 xp_amount_not_integer", [frac.status, frac.body.reason], [422, "xp_amount_not_integer"]);
  const nan = await h.request("POST", "/feed", { collectionId: "heroes", tokenId: "TKN-001", amount: "x" });
  h.expect("non-numeric amount -> 422 invalid_xp_amount", [nan.status, nan.body.reason], [422, "invalid_xp_amount"]);
  const miss = await h.request("POST", "/feed", { collectionId: "heroes", amount: 1 });
  h.expect("missing tokenId -> 422 missing_identifier", [miss.status, miss.body.reason], [422, "missing_identifier"]);
  const unknown = await h.request("POST", "/feed", { collectionId: "heroes", tokenId: "GHOST", amount: 1 });
  h.expect("unknown token -> 409 token_not_found", [unknown.status, unknown.body.reason], [409, "token_not_found"]);

  const releaseLock = ctx.repo.holdTokenLock("sprites", "SPK-007");
  let exhaustion: any;
  try { await ctx.repo.feed(runId, "sprites", "SPK-007", 1, 5); exhaustion = null; }
  catch (err) { exhaustion = err; } finally { releaseLock(); }
  h.check("queued feed under held lock -> 503 feed_serialization_timeout", !!exhaustion && exhaustion.category === "exhausted" && exhaustion.status === 503 && exhaustion.reason === "feed_serialization_timeout", JSON.stringify(exhaustion && { category: exhaustion.category, reason: exhaustion.reason, status: exhaustion.status }));

  let computeErr: any;
  try { const { evolve } = await import("../src/kernel/evolve.js"); evolve({ level: 0, xp: -1, consumedXp: 0 }, 1, { thresholds: [7] }); }
  catch (err) { computeErr = err; }
  h.check("invalid state -> 500 compute failure with distinct reason", !!computeErr && computeErr.category === "compute" && computeErr.status === 500 && typeof computeErr.reason === "string", JSON.stringify(computeErr && { category: computeErr.category, reason: computeErr.reason, status: computeErr.status }));

  console.log("\n================ SUMMARY ================");
  console.log("RUN_ID = " + runId);
  if (h.failures.length === 0) { console.log("ALL SCENARIOS PASSED (" + h.scenarioNo + ")"); await app.close(); process.exit(0); }
  console.log("FAILED SCENARIOS (" + h.failures.length + "):");
  for (const f of h.failures) console.log("  - " + f);
  await app.close();
  process.exit(1);
}

main().catch((err) => { console.error("ACCEPT HARNESS CRASHED"); console.error(err); process.exit(1); });
