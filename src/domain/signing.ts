import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Certificate } from './types.js';

// Canonical payload covered by the issuer signature.
export function canonicalPayload(cert: Omit<Certificate, 'signature'>): string {
  return [
    cert.serial,
    cert.subject,
    cert.issuer,
    cert.notBefore,
    cert.notAfter,
    [...cert.keyUsage].sort().join(','),
  ].join('|');
}

// In this simulation every CA's signing key is derived from a shared master
// secret: key(issuerName) = HMAC(masterSecret, "ca-key:" + issuerName).
// The verifier therefore only needs the master secret to check any link.
export function deriveIssuerKey(masterSecret: string, issuerName: string): string {
  return createHmac('sha256', masterSecret).update('ca-key:' + issuerName).digest('hex');
}

export function signCertificate(
  masterSecret: string,
  cert: Omit<Certificate, 'signature'>,
): string {
  const key = deriveIssuerKey(masterSecret, cert.issuer);
  return createHmac('sha256', key).update(canonicalPayload(cert)).digest('hex');
}

export function verifySignature(masterSecret: string, cert: Certificate): boolean {
  if (!/^[0-9a-f]{64}$/.test(cert.signature)) return false;
  const expected = signCertificate(masterSecret, cert);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(cert.signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

