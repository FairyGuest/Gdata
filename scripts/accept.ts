// One-key acceptance script: exercises every required scenario in a fixed
// order against a real HTTP server backed by a temporary SQLite file.
// Prints each request, response and verdict; exits 0 only if all pass.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AddressInfo } from "node:net";
import { buildServer } from "../src/http/server";
import { AuditStore } from "../src/state/store";

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
let stepNo = 0;

function record(name: string, ok: boolean, detail: string): void {
  stepNo += 1;
  results.push({ name, ok, detail });
  console.log(
    "  [" + (ok ? "PASS" : "FAIL") + "] step " + stepNo + " " + name + " -> " + detail
  );
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "audit-accept-"));
  const dbPath = join(dir, "accept.db");
  console.log("[accept] run-id=" + Date.now() + " db=" + dbPath);

  const store = new AuditStore(dbPath);
  const app = buildServer(store);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const base = "http://127.0.0.1:" + port;
  console.log("[accept] server listening at " + base);

  const post = async (body: unknown) => {
    const res = await fetch(base + "/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };

  try {
    // --- Scenario 1: append events, full chain verifies ---
    console.log("\n== Scenario 1: append 3 events, verify intact chain ==");
    for (const action of ["create", "update", "read"]) {
      const payload = { actor: "alice", action, resource: "doc-1" };
      const r = await post(payload);
      console.log("  POST /events " + JSON.stringify(payload));
      console.log("  -> " + r.status + " " + JSON.stringify(r.body));
      record(
        "append " + action,
        r.status === 201 && typeof r.body.hash === "string" && r.body.hash.length === 64,
        "status=" + r.status + " seq=" + (r.body.seq ?? "?")
      );
    }
    const v1 = await get("/verify");
    console.log("  GET /verify -> " + v1.status + " " + JSON.stringify(v1.body));
    record(
      "verify intact chain",
      v1.status === 200 && v1.body.ok === true && v1.body.length === 3,
      JSON.stringify(v1.body)
    );

    // --- Scenario 2: tamper a middle entry, locate the break ---
    console.log("\n== Scenario 2: tamper middle entry (seq 2), expect HASH_MISMATCH at 2 ==");
    {
      const db = new Database(dbPath);
      db.prepare("UPDATE audit_events SET action = ? WHERE seq = 2").run("forged");
      db.close();
      console.log("  [fixture] UPDATE audit_events SET action='forged' WHERE seq=2");
    }
    const v2 = await get("/verify");
    console.log("  GET /verify -> " + v2.status + " " + JSON.stringify(v2.body));
    record(
      "locate tampered entry",
      v2.body.ok === false && v2.body.brokenAt === 2 && v2.body.code === "HASH_MISMATCH",
      JSON.stringify(v2.body)
    );

    // --- Scenario 3: delete an entry, expect gap detection ---
    console.log("\n== Scenario 3: delete entry seq 2, expect SEQUENCE_GAP at 2 ==");
    {
      const db = new Database(dbPath);
      db.prepare("DELETE FROM audit_events WHERE seq = 2").run();
      db.close();
      console.log("  [fixture] DELETE FROM audit_events WHERE seq=2");
    }
    const v3 = await get("/verify");
    console.log("  GET /verify -> " + v3.status + " " + JSON.stringify(v3.body));
    record(
      "detect sequence gap",
      v3.body.ok === false && v3.body.brokenAt === 2 && v3.body.code === "SEQUENCE_GAP",
      JSON.stringify(v3.body)
    );

    // --- Scenario 4: invalid input rejected with typed error ---
    console.log("\n== Scenario 4: invalid payload rejected as VALIDATION ==");
    const bad = await post({ actor: "alice" });
    console.log("  POST /events {actor only} -> " + bad.status + " " + JSON.stringify(bad.body));
    record(
      "reject invalid payload",
      bad.status === 400 && bad.body.error && bad.body.error.kind === "VALIDATION",
      "status=" + bad.status + " kind=" + (bad.body.error?.kind ?? "?")
    );

    // --- Scenario 5: diagnostics endpoint consistency ---
    console.log("\n== Scenario 5: diagnostics reflects current head ==");
    const diag = await get("/diagnostics");
    console.log("  GET /diagnostics -> " + diag.status + " " + JSON.stringify(diag.body));
    record(
      "diagnostics head",
      diag.status === 200 && diag.body.count === 2 && diag.body.head.seq === 3,
      "count=" + (diag.body.count ?? "?") + " headSeq=" + (diag.body.head?.seq ?? "?")
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    "\n[accept] " + (results.length - failed.length) + "/" + results.length + " steps passed"
  );
  if (failed.length > 0) {
    for (const f of failed) console.log("[accept] FAILED scenario: " + f.name);
    return 1;
  }
  console.log("[accept] ALL SCENARIOS PASSED");
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error("[accept] fatal error:", err);
    process.exitCode = 2;

  });
