import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditError } from "../src/contract/errors";
import { makeService, newRunId, tlog } from "./helpers";
import { GENESIS_PREV_HASH } from "../src/contract/types";

test("append assigns seq from 1 and links genesis prevHash", () => {
  const runId = newRunId();
  const { service, store } = makeService();
  const r1 = service.append({ eventType: "e", payload: { n: 1 } });
  const r2 = service.append({ eventType: "e", payload: { n: 2 } });
  tlog(runId, "append-seq", { r1, r2 }, "seq must start at 1 and increment by 1");
  assert.equal(r1.seq, 1);
  assert.equal(r1.prevHash, GENESIS_PREV_HASH);
  assert.equal(r2.seq, 2);
  assert.equal(r2.prevHash, r1.hash);
  store.close();
});

test("invalid input rejected with INPUT_VALIDATION", () => {
  const runId = newRunId();
  const { service, store } = makeService();
  const cases: unknown[] = [
    { payload: {} },
    { eventType: "", payload: {} },
    { eventType: "e" },
    { eventType: "e", payload: {}, timestamp: "not-a-date" },
  ];
  for (const c of cases) {
    assert.throws(
      () => service.append(c as never),
      (err: unknown) => err instanceof AuditError && err.code === "INPUT_VALIDATION"
    );
  }
  tlog(runId, "input-validation", { cases: cases.length }, "all malformed inputs map to INPUT_VALIDATION");
  store.close();
});

test("oversized payload rejected with RESOURCE_EXHAUSTED", () => {
  const runId = newRunId();
  const { service, store } = makeService({ maxPayloadBytes: 16 });
  assert.throws(
    () => service.append({ eventType: "e", payload: { big: "x".repeat(100) } }),
    (err: unknown) => err instanceof AuditError && err.code === "RESOURCE_EXHAUSTED"
  );
  tlog(runId, "payload-limit", { limit: 16 }, "payload over limit maps to RESOURCE_EXHAUSTED");
  store.close();
});

test("entry limit rejected with RESOURCE_EXHAUSTED", () => {
  const runId = newRunId();
  const { service, store } = makeService({ maxEntries: 2 });
  service.append({ eventType: "e", payload: 1 });
  service.append({ eventType: "e", payload: 2 });
  assert.throws(
    () => service.append({ eventType: "e", payload: 3 }),
    (err: unknown) => err instanceof AuditError && err.code === "RESOURCE_EXHAUSTED"
  );
  tlog(runId, "entry-limit", { limit: 2 }, "third append exceeds maxEntries");
  store.close();
});

test("duplicate seq insert surfaces SEQUENCE_CONFLICT", () => {
  const runId = newRunId();
  const { service, store } = makeService();
  service.append({ eventType: "e", payload: 1 });
  const dup = service.list()[0];
  assert.throws(
    () => store.append(dup),
    (err: unknown) => err instanceof AuditError && err.code === "SEQUENCE_CONFLICT"
  );
  tlog(runId, "seq-conflict", { seq: dup.seq }, "re-inserting same seq hits PRIMARY KEY conflict");
  store.close();
});

