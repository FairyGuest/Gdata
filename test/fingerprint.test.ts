// Fingerprint tests. The reference hash is recomputed here directly with
// node:crypto (independently of src/core/fingerprint.ts).

import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeFingerprint } from "../src/core/fingerprint.ts";

const DIR = join(process.cwd(), ".data-test", "fingerprint");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

test("fingerprint matches independently computed aggregate", () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "a.txt"), "alpha");
  writeFileSync(join(DIR, "b.txt"), "beta");

  const expectedLines = ["a.txt:" + sha256("alpha"), "b.txt:" + sha256("beta")].sort().join("\n");
  const expected = sha256(expectedLines);
  equal(computeFingerprint(DIR, ["a.txt", "b.txt"]), expected);
  // order of watch paths must not matter
  equal(computeFingerprint(DIR, ["b.txt", "a.txt"]), expected);
});

test("fingerprint changes with content and with missing files", () => {
  const before = computeFingerprint(DIR, ["a.txt", "b.txt"]);
  writeFileSync(join(DIR, "a.txt"), "alpha-v2");
  const after = computeFingerprint(DIR, ["a.txt", "b.txt"]);
  ok(before !== after, "content change must change fingerprint");
  const missing = computeFingerprint(DIR, ["a.txt", "gone.txt"]);
  ok(missing !== after, "missing file must be part of the fingerprint");
  // restore: reverting content restores the original fingerprint
  writeFileSync(join(DIR, "a.txt"), "alpha");
  equal(computeFingerprint(DIR, ["a.txt", "b.txt"]), before);
  rmSync(DIR, { recursive: true, force: true });
});
