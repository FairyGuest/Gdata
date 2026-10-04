import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteAuditStore } from "../src/state/sqliteStore";
import { AuditService } from "../src/service/auditService";
import { buildServer } from "../src/http/server";
import { loadConfig } from "../src/config";

interface FixtureEvent {
  eventType: string;
  payload: unknown;
  timestamp: string;
}

let failures = 0;

function step(name: string) {
  console.log("\n--- " + name + " ---");
}

function show(label: string, value: unknown) {
  console.log(label + ": " + JSON.stringify(value));
}

function judge(scenario: string, cond: boolean, reason: string) {
  console.log((cond ? "PASS" : "FAIL") + " [" + scenario + "] " + reason);
  if (!cond) failures += 1;
}

function rawSql(dbPath: string, sql: string, params: unknown[]): void {
  const db = new Database(dbPath);
  db.exec("DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete;");
  db.prepare(sql).run(...params);
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN " +
    "SELECT RAISE(ABORT, 'audit_log is immutable: UPDATE denied'); END;" +
    "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN " +
    "SELECT RAISE(ABORT, 'audit_log is immutable: DELETE denied'); END;"
  );
  db.close();
}

async function main() {
  const dbPath = path.join("data", "accept.db");
  fs.mkdirSync("data", { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
  }

  const config = { ...loadConfig(), dbPath, maxPayloadBytes: 4096 };
  const store = new SqliteAuditStore(dbPath);
  const service = new AuditService(store, config);
  const app = buildServer(service);
  const fixtures = JSON.parse(
    fs.readFileSync(path.join("fixtures", "events.json"), "utf8")
  ) as FixtureEvent[];

  step("S1 append fixture events via POST /events");
  for (const f of fixtures) {
    const res = await app.inject({ method: "POST", url: "/events", payload: f });
    show("POST /events <- " + f.eventType, res.json());
    judge("S1", res.statusCode === 200, "append " + f.eventType + " -> HTTP " + res.statusCode);
  }

  step("S2 verify intact chain via GET /verify");
  let res = await app.inject({ method: "GET", url: "/verify" });
  show("GET /verify", res.json());
  judge("S2", res.json().ok === true && res.json().entryCount === fixtures.length,
    "intact chain must verify ok with " + fixtures.length + " entries");

  step("S3 tamper middle entry (seq 3) then locate break");
  rawSql(dbPath, "UPDATE audit_log SET payload = ? WHERE seq = 3", [
    JSON.stringify({ orderId: "o-5001", channel: "attacker-rewrote-this" }),
  ]);
  res = await app.inject({ method: "GET", url: "/verify" });
  show("GET /verify after tamper", res.json());
  const body3 = res.json();
  judge("S3",
    body3.ok === false && body3.firstBreak?.seq === 3 &&
      body3.firstBreak?.reason === "HASH_RECOMPUTE_MISMATCH",
    "tamper at seq 3 must be located exactly (got " + JSON.stringify(body3.firstBreak) + ")");

  step("S4 delete entry (seq 4) then detect gap");
  rawSql(dbPath, "DELETE FROM audit_log WHERE seq = 4", []);
  res = await app.inject({ method: "GET", url: "/verify" });
  show("GET /verify after delete", res.json());
  const body4 = res.json();
  const gapOk = body4.ok === false && Array.isArray(body4.gaps) &&
    body4.gaps.some((g: { missing: number[] }) => g.missing.includes(4));
  judge("S4", gapOk, "deletion of seq 4 must appear in gaps (got " + JSON.stringify(body4.gaps) + ")");

  step("S5 error semantics: invalid input -> 400 INPUT_VALIDATION");
  res = await app.inject({ method: "POST", url: "/events", payload: { payload: {} } });
  show("POST /events (missing eventType)", res.json());
  judge("S5", res.statusCode === 400 && res.json().error.code === "INPUT_VALIDATION",
    "invalid input maps to 400/INPUT_VALIDATION");

  step("S6 error semantics: oversized payload -> 413 RESOURCE_EXHAUSTED");
  res = await app.inject({
    method: "POST", url: "/events",
    payload: { eventType: "e", payload: { blob: "x".repeat(10000) } },
  });
  show("POST /events (oversized)", res.json());
  judge("S6", res.statusCode === 413 && res.json().error.code === "RESOURCE_EXHAUSTED",
    "oversized payload maps to 413/RESOURCE_EXHAUSTED");

  step("S7 storage immutability: raw UPDATE/DELETE blocked by triggers");
  const rawDb = new Database(dbPath);
  let updateBlocked = false;
  let deleteBlocked = false;
  try { rawDb.prepare("UPDATE audit_log SET hash = 'x' WHERE seq = 1").run(); } catch { updateBlocked = true; }
  try { rawDb.prepare("DELETE FROM audit_log WHERE seq = 1").run(); } catch { deleteBlocked = true; }
  rawDb.close();
  show("trigger enforcement", { updateBlocked, deleteBlocked });
  judge("S7", updateBlocked && deleteBlocked, "UPDATE and DELETE must both be blocked by triggers");

  await app.close();
  store.close();

  console.log("\n========================================");
  if (failures > 0) {
    console.log("ACCEPTANCE FAILED: " + failures + " scenario(s) failed");
    process.exit(1);
  }
  console.log("ACCEPTANCE PASSED: all scenarios green");
  process.exit(0);
}

main().catch((err) => {
  console.error("acceptance crashed:", err);
  process.exit(1);
});

