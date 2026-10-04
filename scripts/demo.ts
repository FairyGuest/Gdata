import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteAuditStore } from "../src/state/sqliteStore";
import { AuditService } from "../src/service/auditService";
import { loadConfig } from "../src/config";

interface FixtureEvent {
  eventType: string;
  payload: unknown;
  timestamp: string;
}

function rawTamper(dbPath: string, sql: string, params: unknown[]): void {
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

function main() {
  const dbPath = path.join("data", "demo.db");
  fs.mkdirSync("data", { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
  }

  const config = { ...loadConfig(), dbPath };
  const store = new SqliteAuditStore(dbPath);
  const service = new AuditService(store, config);
  const fixtures = JSON.parse(
    fs.readFileSync(path.join("fixtures", "events.json"), "utf8")
  ) as FixtureEvent[];

  console.log("=== 1. append fixture events ===");
  for (const f of fixtures) {
    const r = service.append(f);
    console.log("appended seq=" + r.seq + " hash=" + r.hash.slice(0, 16) + "...");
  }

  console.log("\n=== 2. verify intact chain ===");
  let report = service.verify();
  console.log("ok=" + report.ok + " entries=" + report.entryCount);

  console.log("\n=== 3. tamper seq 3 payload (attacker edits DB file) ===");
  rawTamper(dbPath, "UPDATE audit_log SET payload = ? WHERE seq = 3", [
    JSON.stringify({ orderId: "o-5001", channel: "stolen-funds" }),
  ]);
  report = service.verify();
  console.log("ok=" + report.ok);
  console.log("firstBreak=" + JSON.stringify(report.firstBreak));

  console.log("\n=== 4. delete seq 4 (attacker removes a row) ===");
  rawTamper(dbPath, "DELETE FROM audit_log WHERE seq = 4", []);
  report = service.verify();
  console.log("ok=" + report.ok);
  console.log("gaps=" + JSON.stringify(report.gaps));

  store.close();
  console.log("\ndemo finished; db at " + dbPath);
}

main();

