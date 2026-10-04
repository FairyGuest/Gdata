/**
 * One-shot acceptance script: exercises every scenario from the spec in a
 * fixed order, printing request, response and verdict per step.
 * Exit 0 when all pass, non-zero naming the failed scenario otherwise.
 */
import { buildApp } from "../src/server.js";
import { defaultConfig } from "../src/config.js";

const RUN_ID = "accept-" + process.pid.toString(36);
const failures: string[] = [];
let stepNo = 0;

function log(...args: unknown[]) {
  console.log("[run=" + RUN_ID + "]", ...args);
}

function check(scenario: string, cond: boolean, reason: string) {
  stepNo++;
  if (cond) {
    log("  PASS step", stepNo, "-", reason);
  } else {
    log("  FAIL step", stepNo, "-", reason);
    failures.push(scenario + " :: step " + stepNo + " :: " + reason);
  }
}

async function main() {
  const { app, db } = buildApp({ ...defaultConfig, dbPath: ":memory:" });
  const feed = (tokenId: number, amount: number) =>
    app.inject({ method: "POST", url: "/feed", payload: { tokenId, amount } });
  const meta = (id: number) => app.inject({ method: "GET", url: "/tokens/" + id + "/metadata" });
  const ledger = (id: number) => app.inject({ method: "GET", url: "/diag/tokens/" + id + "/ledger" });

  // --- Scenario 1: non-divisible ladder (threshold 7; feed 5 then 4) -------
  log("SCENARIO 1: ladder 7, feed 5 then feed 4 on token 1");
  const f1 = await feed(1, 5);
  log("  req feed(1,5) ->", f1.statusCode, f1.body);
  const f2 = await feed(1, 4);
  log("  req feed(1,4) ->", f2.statusCode, f2.body);
  // independent reference: 5+4=9, 9-7=2 -> level 2, xp 2
  check("S1", f1.statusCode === 200 && f2.statusCode === 200, "both feeds return 200");
  check("S1", f2.json().level === 2 && f2.json().xp === 2, "level=2 xp=2 after 9 XP vs threshold 7");
  check("S1", f2.json().consumed === 7 && f2.json().transitions === 1, "exactly one transition consuming 7");

  // --- Scenario 2: deterministic rendering ---------------------------------
  log("SCENARIO 2: deterministic render of token 1 (level 2, xp 2)");
  const m1 = await meta(1);
  const m2 = await meta(1);
  check("S2", m1.body === m2.body, "two renders are byte-identical");
  const before = m1.json();
  const up = await feed(1, 8); // xp 2 + 8 = 10 >= threshold(2)=10 -> level 3, xp 0
  log("  req feed(1,8) ->", up.statusCode, up.body);
  const after = (await meta(1)).json();
  const levelFieldsChanged =
    before.name !== after.name && before.tier !== after.tier && before.image !== after.image;
  const staticSame =
    JSON.stringify(before.attributes.find((a: any) => a.trait_type === "Background")) ===
    JSON.stringify(after.attributes.find((a: any) => a.trait_type === "Background"));
  check("S2", levelFieldsChanged, "level-up changes name/tier/image");
  check("S2", staticSame, "level-independent attributes unchanged");
  check("S2", !("renderedAt" in after) && !("requestId" in after), "no clock/request-id fields in metadata");

  // --- Scenario 3: concurrent double feed, no lost update -------------------
  log("SCENARIO 3: concurrent feed(3,4) and feed(3,5)");
  const [c1, c2] = await Promise.all([feed(3, 4), feed(3, 5)]);
  log("  resp A ->", c1.statusCode, c1.body);
  log("  resp B ->", c2.statusCode, c2.body);
  check("S3", c1.statusCode === 200 && c2.statusCode === 200, "both concurrent feeds return 200");
  check("S3", c1.json().commitSeq !== c2.json().commitSeq, "distinct commit sequences (serialized)");
  const led3 = (await ledger(3)).json();
  log("  ledger token 3 ->", JSON.stringify(led3));
  check("S3", led3.total_fed === 9, "total_fed=9 (no lost update)");
  check("S3", led3.total_consumed === 7 && led3.xp === 2 && led3.level === 2,
    "consumed=7, xp=2, level=2");
  check("S3", led3.total_fed === led3.total_consumed + led3.xp, "ledger conservation holds");
  const hist = (await app.inject({ method: "GET", url: "/diag/tokens/3/history" })).json();
  check("S3", hist.transitions.length === 2 &&
    hist.transitions[0].seq < hist.transitions[1].seq, "history has both feeds in commit order");

  // --- Scenario 4: reset permission + effect --------------------------------
  log("SCENARIO 4: reset token 3 (intruder then admin-1)");
  const bad = await app.inject({
    method: "POST", url: "/reset", payload: { tokenId: 3 }, headers: { "x-admin-id": "intruder" },
  });
  log("  reset as intruder ->", bad.statusCode, bad.body);
  check("S4", bad.statusCode === 422 && bad.json().error.reason === "not_collection_admin",
    "non-admin reset rejected 422/not_collection_admin");
  const ok = await app.inject({
    method: "POST", url: "/reset", payload: { tokenId: 3 }, headers: { "x-admin-id": "admin-1" },
  });
  log("  reset as admin-1 ->", ok.statusCode, ok.body);
  const afterReset = (await meta(3)).json();
  check("S4", ok.statusCode === 200 && afterReset.level === 1 && afterReset.xp === 0,
    "admin reset returns token to level 1 / xp 0 and render reflects it");

  // --- Scenario 5: max level conflict ---------------------------------------
  log("SCENARIO 5: feed token 4 to max level, then feed again");
  const toMax = await feed(4, 40); // 7+10+15=32 consumed, xp 8, level 4
  log("  feed(4,40) ->", toMax.statusCode, toMax.body);
  check("S5", toMax.statusCode === 200 && toMax.json().level === 4, "token reaches max level 4");
  const over = await feed(4, 1);
  log("  feed(4,1) ->", over.statusCode, over.body);
  check("S5", over.statusCode === 409 && over.json().error.reason === "max_level_reached",
    "feed at max level -> 409 max_level_reached");

  // --- Scenario 6: error taxonomy -------------------------------------------
  log("SCENARIO 6: error categories 422 / 503 distinguishable");
  const badXp = await feed(1, -5);
  log("  feed(1,-5) ->", badXp.statusCode, badXp.body);
  check("S6", badXp.statusCode === 422 && badXp.json().error.reason === "invalid_xp_amount",
    "negative XP -> 422 invalid_xp_amount");
  const ghost = await feed(999, 1);
  log("  feed(999,1) ->", ghost.statusCode, ghost.body);
  check("S6", ghost.statusCode === 422 && ghost.json().error.reason === "token_not_found",
    "unknown token -> 422 token_not_found");
  const huge = await feed(1, 2_000_000);
  log("  feed(1,2000000) ->", huge.statusCode, huge.body);
  check("S6", huge.statusCode === 503 && huge.json().error.reason === "feed_amount_exceeds_capacity",
    "oversized feed -> 503 feed_amount_exceeds_capacity");

  await app.close();
  db.close();

  if (failures.length > 0) {
    log("FAILED SCENARIOS:");
    for (const f of failures) console.log("  [FAIL]", f);
    process.exit(1);
  }
  log("ALL SCENARIOS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("[run=" + RUN_ID + "] accept script crashed:", err);
  process.exit(2);
});
