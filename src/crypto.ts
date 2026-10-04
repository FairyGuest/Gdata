import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { VaultError } from "./errors.ts";

export interface Ciphertext {
  /** base64-encoded AES-256-GCM ciphertext */
  ciphertext: string;
  /** base64-encoded 12-byte IV */
  iv: string;
  /** base64-encoded 16-byte auth tag */
  tag: string;
  /** identifier of the master key used */
  keyId: string;
}

/**
 * AES-256-GCM cipher. Encrypt before write, decrypt after read.
 * A fresh random IV is generated per encryption.
 */
export class AesGcmCipher {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(masterKeyHex: string, keyId = "master-v1") {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      throw new VaultError("VALIDATION_ERROR", "master key must be 64 hex chars (32 bytes)");
    }
    this.key = Buffer.from(masterKeyHex, "hex");
    this.keyId = keyId;
  }

  encrypt(plaintext: string): Ciphertext {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ciphertext: ct.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        keyId: this.keyId,
      };
    } catch (err) {
      throw new VaultError("CRYPTO_ERROR", `encryption failed: ${(err as Error).message}`);
    }
  }

  decrypt(payload: Ciphertext): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(payload.iv, "base64"));
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (err) {
      throw new VaultError("CRYPTO_ERROR", `decryption failed: ${(err as Error).message}`);
    }
  }
}
