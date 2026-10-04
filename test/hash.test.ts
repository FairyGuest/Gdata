import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, computeEntryHash, canonicalize } from "../src/core/hash";
import { newRunId, tlog } from "./helpers";

test("sha256Hex matches known vector for 'abc'", () => {
  const runId = newRunId();
  const got = sha256Hex("abc");
  const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  tlog(runId, "known-vector", { got, want }, "independent RFC vector, not produced by core impl");
  assert.equal(got, want);
});

test("computeEntryHash matches independently constructed material string", () => {
  const runId = newRunId();
  const material = {
    seq: 3,
    timestamp: "2026-01-01T00:00:00.000Z",
    eventType: "order.paid",
    payload: { b: 2, a: 1 },
    prevHash: "f".repeat(64),
  };
  const independent =
    material.seq + "|" + material.timestamp + "|" + material.eventType +
    "|" + "{\"a\":1,\"b\":2}" + "|" + material.prevHash;
  const want = createHash("sha256").update(independent, "utf8").digest("hex");
  const got = computeEntryHash(material);
  tlog(runId, "entry-hash", { independent, want, got }, "expected value built by hand in test");
  assert.equal(got, want);
});

test("canonicalize sorts object keys", () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] }), "{\"a\":[2,{\"c\":3,\"d\":4}],\"b\":1}");
});

