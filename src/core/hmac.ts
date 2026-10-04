import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Certificate } from '../domain/types.ts';

/** 规范载荷：字段固定顺序拼接，签名与验证双方必须一致 */
export function canonicalPayload(cert: Omit<Certificate, 'signature'>): string {
  return [
    cert.id,
    cert.subject,
    cert.issuer,
    cert.notBefore,
    cert.notAfter,
    [...cert.keyUsage].sort().join(','),
  ].join('|');
}

export function signPayload(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

export function verifySignature(cert: Certificate, issuerKey: string): boolean {
  const expected = signPayload(canonicalPayload(cert), issuerKey);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(cert.signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
