import { test } from "node:test";
import assert from "node:assert/strict";
import { AesGcmCipher } from "../src/crypto.ts";
import { VaultError } from "../src/errors.ts";

// Reference vector produced independently via node:crypto one-shot
// (key=0x00*32, iv=0x01*12, plaintext='vault-reference-vector').
const REFERENCE = {
  key: "00".repeat(32),
  iv: "AQEBAQEBAQEBAQEB",
  plaintext: "vault-reference-vector",
  ciphertext: "AyG2Bg6kCpgE05bj1UwZRMoAjy9glA==",
  tag: "dxwH3wW0mb1y4bn8O0UUYA==",
};

test("decrypt matches independently generated reference vector", () => {
  const cipher = new AesGcmCipher(REFERENCE.key);
  const out = cipher.decrypt({ ciphertext: REFERENCE.ciphertext, iv: REFERENCE.iv, tag: REFERENCE.tag, keyId: "k" });
  assert.equal(out, REFERENCE.plaintext);
});

test("encrypt/decrypt roundtrip preserves arbitrary utf-8", () => {
  const cipher = new AesGcmCipher("ab".repeat(32));
  const samples = ["s3cr3t!", "多语言密钥🔑", "x".repeat(10_000)];
  for (const s of samples) {
    const enc = cipher.encrypt(s);
    assert.notEqual(enc.ciphertext, s);
    assert.equal(cipher.decrypt(enc), s);
  }
});

test("two encryptions of the same plaintext differ (random IV)", () => {
  const cipher = new AesGcmCipher("cd".repeat(32));
  const a = cipher.encrypt("same");
  const b = cipher.encrypt("same");
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.iv, b.iv);
});

test("tampered ciphertext fails with CRYPTO_ERROR, not a wrong value", () => {
  const cipher = new AesGcmCipher("ef".repeat(32));
  const enc = cipher.encrypt("integrity-check");
  const raw = Buffer.from(enc.ciphertext, "base64");
  raw[0] ^= 0xff;
  assert.throws(
    () => cipher.decrypt({ ...enc, ciphertext: raw.toString("base64") }),
    (e: unknown) => e instanceof VaultError && e.code === "CRYPTO_ERROR"
  );
});

test("wrong key fails with CRYPTO_ERROR", () => {
  const enc = new AesGcmCipher("11".repeat(32)).encrypt("hello");
  assert.throws(
    () => new AesGcmCipher("22".repeat(32)).decrypt(enc),
    (e: unknown) => e instanceof VaultError && e.code === "CRYPTO_ERROR"
  );
});

test("invalid master key rejected with VALIDATION_ERROR", () => {
  assert.throws(() => new AesGcmCipher("not-hex"), (e: unknown) => e instanceof VaultError && e.code === "VALIDATION_ERROR");
});
