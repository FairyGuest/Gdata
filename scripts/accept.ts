/**
 * One-shot acceptance run. Exercises, in a fixed order:
 *   1. multi-version write & read
 *   2. rotation grace period incl. exact-expiry boundary
 *   3. audit log completeness & immutability
 *   4. AES-256-GCM encrypt/decrypt roundtrip (independent reference vector)
 *   5. error taxonomy (validation / not-found / expired)
 * Prints every step's request, response and verdict. Exit 0 iff all pass.
 */
import { VirtualClock } from "../src/clock.ts";
import { AesGcmCipher } from "../src/crypto.ts";
import { SqliteStore } from "../src/store.ts";
import { VaultCore } from "../src/core.ts";
import { buildServer } from "../src/server.ts";

const RUN_ID = `accept-${Date.now()}`;
const GRACE_MS = 5_000;
const KEY = "b".repeat(64);

const clock = new VirtualClock(1_700_000_000_000);
const store = new SqliteStore(":memory:");
const cipher = new AesGcmCipher(KEY);
const core = new VaultCore({ store, cipher, clock, gracePeriodMs: GRACE_MS, runId: RUN_ID });
const app = buildServer({ core, store, clock, runId: RUN_ID });

let failures = 0;
let step = 0;

function log(...args: unknown[]) {
  console.log(`[accept][${RUN_ID}]`, ...args);
}

async function check(title: string, reason: string, fn: () => Promise<void> | void) {
  step += 1;
  try {
    await fn();
    log(`PASS #${step} ${title} | reason: ${reason}`);
  } catch (err) {
    failures += 1;
    log(`FAIL #${step} ${title} | reason: ${reason} | error: ${(err as Error).message}`);
  }
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function req(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown> });
  log(`  -> ${method} ${url}${payload ? " body=" + JSON.stringify(payload) : ""}`);
  log(`  <- ${res.statusCode} ${res.body}`);
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

// ---------- scenario 1: multi-version write & read ----------
await check("multi-version write/read", "3 writes must yield versions 1..3, each readable", async () => {
  for (const [i, v] of ["alpha", "beta", "gamma"].entries()) {
    const r = await req("PUT", "/secrets/db.password", { value: v });
    expect(r.status === 200, `put#${i + 1} status ${r.status}`);
    expect((r.body.data as { version: number }).version === i + 1, `expected version ${i + 1}`);
  }
  const latest = await req("GET", "/secrets/db.password");
  expect(latest.body.value === "gamma", "latest should be gamma");
  const v1 = await req("GET", "/secrets/db.password?version=1");
  expect(v1.body.value === "alpha", "v1 should still read alpha");
});

// ---------- scenario 2: rotation grace incl. exact boundary ----------
await check("rotation grace period", "old version readable before graceUntil, expired exactly at graceUntil", async () => {
  const t0 = clock.nowMs();
  const rot = await req("POST", "/secrets/db.password/rotate");
  expect(rot.status === 200, "rotate status");
  expect(rot.body.version === 4, `rotated version should be 4, got ${rot.body.version}`);
  expect(rot.body.graceUntil === t0 + GRACE_MS, "graceUntil = now + grace");

  clock.set(t0 + GRACE_MS - 1);
  const during = await req("GET", "/secrets/db.password?version=3");
  expect(during.status === 200 && during.body.value === "gamma", "v3 readable 1ms before expiry");

  clock.set(t0 + GRACE_MS);
  const atBoundary = await req("GET", "/secrets/db.password?version=3");
  expect(atBoundary.status === 410, `at graceUntil expect 410, got ${atBoundary.status}`);
  expect((atBoundary.body.error as { code: string }).code === "VERSION_EXPIRED", "error code VERSION_EXPIRED");

  const still = await req("GET", "/secrets/db.password");
  expect(still.status === 200 && still.body.version === 4, "latest version unaffected by expiry");
});

// ---------- scenario 3: audit completeness & immutability ----------
await check("audit log", "every op audited with runId; log rejects update/delete", async () => {
  const audit = await req("GET", "/audit?name=db.password");
  const entries = audit.body.entries as Array<Record<string, unknown>>;
  expect(entries.every((e) => e.runId === RUN_ID), "all rows carry the run id");
  expect(entries.filter((e) => e.action === "put").length === 3, "3 put audits");
  expect(entries.filter((e) => e.action === "rotate").length === 1, "1 rotate audit");
  const failed = entries.filter((e) => e.result === "failure");
  expect(failed.length === 1 && failed[0].errorCode === "VERSION_EXPIRED", "expired read audited as failure");

  let rejected = false;
  try {
    store.rawExec("DELETE FROM audit_log");
  } catch {
    rejected = true;
  }
  expect(rejected, "DELETE on audit_log must be rejected");
  const after = await req("GET", "/audit?name=db.password");
  expect((after.body.entries as unknown[]).length === entries.length, "audit rows unchanged after delete attempt");
});

// ---------- scenario 4: crypto roundtrip with independent reference ----------
await check("crypto roundtrip", "decrypt of independent reference vector + tamper detection", () => {
  // Reference vector generated independently via node:crypto (key=0x00*32, iv=0x01*12).
  const ref = new AesGcmCipher("00".repeat(32));
  const out = ref.decrypt({
    ciphertext: "AyG2Bg6kCpgE05bj1UwZRMoAjy9glA==",
    iv: "AQEBAQEBAQEBAQEB",
    tag: "dxwH3wW0mb1y4bn8O0UUYA==",
    keyId: "ref",
  });
  expect(out === "vault-reference-vector", `reference decrypt mismatch: ${out}`);

  const enc = cipher.encrypt("roundtrip-🔑");
  expect(cipher.decrypt(enc) === "roundtrip-🔑", "roundtrip mismatch");
  const raw = Buffer.from(enc.ciphertext, "base64");
  raw[0] ^= 1;
  let tamperFailed = false;
  try {
    cipher.decrypt({ ...enc, ciphertext: raw.toString("base64") });
  } catch (e) {
    tamperFailed = (e as { code?: string }).code === "CRYPTO_ERROR";
  }
  expect(tamperFailed, "tampered ciphertext must raise CRYPTO_ERROR");
});

// ---------- scenario 5: error taxonomy ----------
await check("error taxonomy", "400 VALIDATION / 404 NOT_FOUND / 410 EXPIRED are distinct", async () => {
  const bad = await req("PUT", "/secrets/db.password", {});
  expect(bad.status === 400 && (bad.body.error as { code: string }).code === "VALIDATION_ERROR", "empty value -> 400 VALIDATION_ERROR");
  const ghost = await req("GET", "/secrets/ghost");
  expect(ghost.status === 404 && (ghost.body.error as { code: string }).code === "SECRET_NOT_FOUND", "missing -> 404 SECRET_NOT_FOUND");
  const noVer = await req("GET", "/secrets/db.password?version=99");
  expect(noVer.status === 404 && (noVer.body.error as { code: string }).code === "VERSION_NOT_FOUND", "bad version -> 404 VERSION_NOT_FOUND");
});

log(failures === 0 ? `ALL ${step} CHECKS PASSED` : `${failures}/${step} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
