import type { Certificate } from '../domain/types.js';
import { signCertificate } from '../domain/signing.js';

export const ROOT_SUBJECT = 'CN=Demo Root CA';
export const INTERMEDIATE_SUBJECT = 'CN=Demo Intermediate CA';
export const LEAF_SUBJECT = 'CN=service.local';

export const DAY = 24 * 60 * 60 * 1000;

export interface CertSpec {
  serial: string;
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  keyUsage: string[];
}

export function issueCertificate(masterSecret: string, spec: CertSpec): Certificate {
  const unsigned = {
    serial: spec.serial,
    subject: spec.subject,
    issuer: spec.issuer,
    notBefore: spec.notBefore.toISOString(),
    notAfter: spec.notAfter.toISOString(),
    keyUsage: spec.keyUsage,
  };
  return { ...unsigned, signature: signCertificate(masterSecret, unsigned) };
}

export interface FixtureChain {
  root: Certificate;
  intermediate: Certificate;
  leaf: Certificate;
  chain: Certificate[]; // leaf-first
}

// Builds a fully valid leaf -> intermediate -> root chain relative to "now".
export function buildValidChain(masterSecret: string, now: Date, leafLifetimeDays = 90): FixtureChain {
  const root = issueCertificate(masterSecret, {
    serial: 'root-1',
    subject: ROOT_SUBJECT,
    issuer: ROOT_SUBJECT,
    notBefore: new Date(now.getTime() - 365 * DAY),
    notAfter: new Date(now.getTime() + 10 * 365 * DAY),
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
  const intermediate = issueCertificate(masterSecret, {
    serial: 'int-1',
    subject: INTERMEDIATE_SUBJECT,
    issuer: ROOT_SUBJECT,
    notBefore: new Date(now.getTime() - 30 * DAY),
    notAfter: new Date(now.getTime() + 365 * DAY),
    keyUsage: ['keyCertSign'],
  });
  const leaf = issueCertificate(masterSecret, {
    serial: 'leaf-1',
    subject: LEAF_SUBJECT,
    issuer: INTERMEDIATE_SUBJECT,
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + leafLifetimeDays * DAY),
    keyUsage: ['digitalSignature', 'keyEncipherment'],
  });
  return { root, intermediate, leaf, chain: [leaf, intermediate, root] };
}

