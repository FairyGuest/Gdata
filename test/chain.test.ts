import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, canonicalPayload, verifyChain } from "../src/core/chain";
import { GENESIS_HASH } from "../src/contract/types";

// Reference hash computed independently with .NET SHA256 over the canonical
// payload string (NOT produced by the implementation under test):
// payload = canonicalPayload(1, "2026-01-01T00:00:00.000Z", GENESIS_HASH,
//   { actor: "alice", action: "create", resource: "doc-1" })
const INDEPENDENT_REFERENCE_HASH =
  "8599898470c0f416cb5612b121260b5271f8806a29c09029d283270b5f96dcb9";

test("hash matches independent external reference vector", () => {
  const event = buildEvent(
    1,
    GENESIS_HASH,
    { actor: "alice", action: "create", resource: "doc-1" },
    "2026-01-01T00:00:00.000Z"
  );
  console.log(
    "[run=ref-vector] payload=" +
      canonicalPayload(1, "2026-01-01T00:00:00.000Z", GENESIS_HASH, event) +
      " hash=" +
      event.hash
  );
  assert.equal(event.hash, INDEPENDENT_REFERENCE_HASH);
});

test("chain verifies for valid events", () => {
  const e1 = buildEvent(1, GENESIS_HASH, { actor: "a", action: "create", resource: "r1" });
  const e2 = buildEvent(2, e1.hash, { actor: "b", action: "update", resource: "r1" });
  const result = verifyChain([e1, e2]);
  console.log("[run=valid-chain] ok=" + result.ok + " length=" + result.length);
  assert.equal(result.ok, true);
  assert.equal(result.length, 2);
});

test("tampering middle entry is located with HASH_MISMATCH", () => {
  const e1 = buildEvent(1, GENESIS_HASH, { actor: "a", action: "create", resource: "r1" });
  const e2 = buildEvent(2, e1.hash, { actor: "b", action: "update", resource: "r1" });
  const e3 = buildEvent(3, e2.hash, { actor: "c", action: "read", resource: "r1" });
  e2.action = "delete"; // attacker alters stored content without recomputing hash
  const result = verifyChain([e1, e2, e3]);
  console.log(
    "[run=tamper-middle] brokenAt=" + result.brokenAt + " code=" + result.code +
      " reason=" + result.reason
  );
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
  assert.equal(result.code, "HASH_MISMATCH");
});

test("deleted entry is detected as SEQUENCE_GAP at first missing position", () => {
  const e1 = buildEvent(1, GENESIS_HASH, { actor: "a", action: "create", resource: "r1" });
  const e2 = buildEvent(2, e1.hash, { actor: "b", action: "update", resource: "r1" });
  const e3 = buildEvent(3, e2.hash, { actor: "c", action: "read", resource: "r1" });
  const result = verifyChain([e1, e3]); // seq 2 deleted
  console.log(
    "[run=gap-delete] brokenAt=" + result.brokenAt + " code=" + result.code +
      " reason=" + result.reason
  );
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
  assert.equal(result.code, "SEQUENCE_GAP");
});

test("forged prevHash link is detected as PREV_HASH_MISMATCH", () => {
  const e1 = buildEvent(1, GENESIS_HASH, { actor: "a", action: "create", resource: "r1" });
  const e2 = buildEvent(2, e1.hash, { actor: "b", action: "update", resource: "r1" });
  e2.prevHash = GENESIS_HASH; // attacker rewires the link
  const result = verifyChain([e1, e2]);
  console.log("[run=prevhash-forge] code=" + result.code + " brokenAt=" + result.brokenAt);
  assert.equal(result.ok, false);
  assert.equal(result.code, "PREV_HASH_MISMATCH");
  assert.equal(result.brokenAt, 2);
});

test("empty chain verifies as ok", () => {
  const result = verifyChain([]);
  assert.deepEqual(result, { ok: true, length: 0 });
});
