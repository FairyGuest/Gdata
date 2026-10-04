import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { VaultError } from './errors.js';

export interface CiphertextBundle {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

export interface Cipher {
  readonly keyId: string;
  encrypt(plaintext: Buffer, aad: string): CiphertextBundle;
  decrypt(bundle: CiphertextBundle, aad: string): Buffer;
}

export class Aes256GcmCipher implements Cipher {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(key: Buffer, keyId?: string) {
    if (key.length !== 32) {
      throw new VaultError('VALIDATION', 'AES-256-GCM key must be 32 bytes', {
        actualBytes: key.length,
      });
    }
    this.key = key;
    this.keyId = keyId ?? createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  encrypt(plaintext: Buffer, aad: string): CiphertextBundle {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag, keyId: this.keyId };
  }

  decrypt(bundle: CiphertextBundle, aad: string): Buffer {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, bundle.iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(bundle.tag);
      return Buffer.concat([decipher.update(bundle.ciphertext), decipher.final()]);
    } catch {
      throw new VaultError('CRYPTO_FAILURE', 'AES-GCM authentication failed: ciphertext or tag tampered', {
        keyId: bundle.keyId,
      });
    }
  }
}
