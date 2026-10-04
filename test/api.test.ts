import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildServer } from "../src/http/server";
import { AuditStore } from "../src/state/store";

const store = new AuditStore(":memory:");
const app = buildServer(store);

before(async () => {
  await app.ready();
});

after(async () => {
  await app.close();
  store.close();
});

test("POST /events appends and GET /verify passes", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/events",
    payload: { actor: "alice", action: "login", resource: "session" },
  });
  assert.equal(res.statusCode, 201);
  const event = res.json();
  console.log("[run=api-append] seq=" + event.seq + " hash=" + event.hash);
  assert.equal(event.seq, 1);
  assert.equal(event.hash.length, 64);

  const verify = await app.inject({ method: "GET", url: "/verify" });
  assert.deepEqual(verify.json(), { ok: true, length: 1 });
});

test("POST /events rejects invalid payload with VALIDATION error", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/events",
    payload: { actor: "alice" },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  console.log("[run=api-invalid] kind=" + body.error.kind);
  assert.equal(body.error.kind, "VALIDATION");
});

test("GET /events lists appended events", async () => {
  const res = await app.inject({ method: "GET", url: "/events" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].actor, "alice");
});

test("GET /diagnostics reports head and count", async () => {
  const res = await app.inject({ method: "GET", url: "/diagnostics" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  console.log("[run=api-diag] count=" + body.count + " headSeq=" + body.head.seq);
  assert.equal(body.count, 1);
  assert.equal(body.head.seq, 1);
  assert.equal(body.head.hash.length, 64);
});

test("capacity limit yields RESOURCE_EXHAUSTED", async () => {
  const tiny = new AuditStore(":memory:", { maxEvents: 1 });
  const tinyApp = buildServer(tiny);
  await tinyApp.ready();
  const first = await tinyApp.inject({
    method: "POST",
    url: "/events",
    payload: { actor: "a", action: "x", resource: "r" },
  });
  assert.equal(first.statusCode, 201);
  const second = await tinyApp.inject({
    method: "POST",
    url: "/events",
    payload: { actor: "a", action: "y", resource: "r" },
  });
  assert.equal(second.statusCode, 507);
  const body = second.json();
  console.log("[run=api-capacity] kind=" + body.error.kind);
  assert.equal(body.error.kind, "RESOURCE_EXHAUSTED");
  await tinyApp.close();
  tiny.close();
});

test("tampering a stored row is located by /verify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const dbPath = join(dir, "tamper.db");
  const s = new AuditStore(dbPath);
  const a = buildServer(s);
  await a.ready();
  for (const action of ["create", "update", "read"]) {
    const r = await a.inject({
      method: "POST",
      url: "/events",
      payload: { actor: "mallory", action, resource: "vault" },
    });
    assert.equal(r.statusCode, 201);
  }
  // attacker edits the middle row directly in SQLite
  const db = new Database(dbPath);
  db.prepare("UPDATE audit_events SET action = ? WHERE seq = 2").run("drop-table");
  db.close();
  const verify = await a.inject({ method: "GET", url: "/verify" });
  const body = verify.json();
  console.log(
    "[run=api-tamper] brokenAt=" + body.brokenAt + " code=" + body.code
  );
  assert.equal(body.ok, false);
  assert.equal(body.brokenAt, 2);
  assert.equal(body.code, "HASH_MISMATCH");
  await a.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("deleting a stored row is detected as SEQUENCE_GAP by /verify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const dbPath = join(dir, "gap.db");
  const s = new AuditStore(dbPath);
  const a = buildServer(s);
  await a.ready();
  for (const action of ["create", "update", "read"]) {
    const r = await a.inject({
      method: "POST",
      url: "/events",
      payload: { actor: "mallory", action, resource: "vault" },
    });
    assert.equal(r.statusCode, 201);
  }
  const db = new Database(dbPath);
  db.prepare("DELETE FROM audit_events WHERE seq = 2").run();
  db.close();
  const verify = await a.inject({ method: "GET", url: "/verify" });
  const body = verify.json();
  console.log("[run=api-gap] brokenAt=" + body.brokenAt + " code=" + body.code);
  assert.equal(body.ok, false);
  assert.equal(body.brokenAt, 2);
  assert.equal(body.code, "SEQUENCE_GAP");
  await a.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
