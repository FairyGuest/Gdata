import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { verifyEntries } from "../src/core/chain";
import { makeService, newRunId, tlog } from "./helpers";
import { LogEntry } from "../src/contract/types";

function seedChain(n: number): LogEntry[] {
  const { service, store } = makeService();
  for (let i = 1; i <= n; i++) {
    service.append({
      eventType: "test.event",
      payload: { i },
      timestamp: "2026-01-01T00:00:0" + i + ".000Z",
    });
  }
  const entries = service.list();
  store.close();
  return entries;
}

test("intact chain verifies ok", () => {
  const runId = newRunId();
  const entries = seedChain(5);
  const report = verifyEntries(entries);
  tlog(runId, "verify-intact", { entryCount: report.entryCount, ok: report.ok }, "fresh 5-entry chain must pass");
  assert.equal(report.ok, true);
  assert.equal(report.entryCount, 5);
  assert.equal(report.firstBreak, null);
  assert.deepEqual(report.gaps, []);
});

test("tampered middle entry is located at exact seq", () => {
  const runId = newRunId();
  const entries = seedChain(5);
  entries[2] = { ...entries[2], payload: { i: 999 } };
  const report = verifyEntries(entries);
  tlog(runId, "verify-tampered", { firstBreak: report.firstBreak }, "payload of seq 3 altered in place");
  assert.equal(report.ok, false);
  assert.equal(report.firstBreak?.seq, 3);
  assert.equal(report.firstBreak?.reason, "HASH_RECOMPUTE_MISMATCH");
});

test("broken prev-hash link is located at exact seq", () => {
  const runId = newRunId();
  const entries = seedChain(4);
  entries[3] = { ...entries[3], prevHash: "0".repeat(64) };
  const report = verifyEntries(entries);
  tlog(runId, "verify-badlink", { firstBreak: report.firstBreak }, "prevHash of seq 4 corrupted");
  assert.equal(report.ok, false);
  assert.equal(report.firstBreak?.seq, 4);
  assert.equal(report.firstBreak?.reason, "PREV_HASH_MISMATCH");
});

test("deleted middle entry produces gap report", () => {
  const runId = newRunId();
  const entries = seedChain(5).filter((e) => e.seq !== 3);
  const report = verifyEntries(entries);
  tlog(runId, "verify-gap", { gaps: report.gaps, firstBreak: report.firstBreak }, "seq 3 removed from chain");
  assert.equal(report.ok, false);
  assert.equal(report.gaps.length, 1);
  assert.deepEqual(report.gaps[0].missing, [3]);
  assert.equal(report.gaps[0].afterSeq, 2);
  assert.equal(report.gaps[0].beforeSeq, 4);
});

test("chain not starting at seq 1 is rejected", () => {
  const runId = newRunId();
  const entries = seedChain(3).slice(1);
  const report = verifyEntries(entries);
  tlog(runId, "verify-non-one-base", { firstBreak: report.firstBreak, gaps: report.gaps }, "first entry has seq 2");
  assert.equal(report.ok, false);
  assert.ok(report.gaps.length >= 1);
  assert.deepEqual(report.gaps[0].missing, [1]);
});

test("immutability enforced via raw sqlite connection", () => {
  const runId = newRunId();
  const { service, store } = makeService();
  service.append({ eventType: "a", payload: { x: 1 } });
  const db = (store as unknown as { db: Database.Database }).db;
  assert.throws(
    () => db.prepare("UPDATE audit_log SET hash = ? WHERE seq = 1").run("x"),
    /immutable/
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_log WHERE seq = 1").run(),
    /immutable/
  );
  tlog(runId, "immutability", { update: "blocked", delete: "blocked" }, "triggers RAISE(ABORT) on UPDATE/DELETE");
  store.close();
});

