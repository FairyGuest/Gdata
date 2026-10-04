import type {
  Certificate,
  FailureCode,
  LinkReport,
  VerifyResult,
} from '../domain/types.js';
import type { VirtualClock } from '../domain/clock.js';
import { verifySignature } from '../domain/signing.js';
import { remainingDays, renewalActionFor, type RenewalPolicy } from './renewal.js';

export interface VerifyOptions {
  masterSecret: string;
  trustedRoots: string[];
  policy: RenewalPolicy;
  maxChainLength: number;
  runId: string;
}

export interface VerifyInput {
  chain: Certificate[]; // ordered leaf-first, root last
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function validateCertificateShape(cert: unknown): cert is Certificate {
  if (typeof cert !== 'object' || cert === null) return false;
  const c = cert as Record<string, unknown>;
  return (
    typeof c.serial === 'string' && c.serial.length > 0 &&
    typeof c.subject === 'string' && c.subject.length > 0 &&
    typeof c.issuer === 'string' && c.issuer.length > 0 &&
    typeof c.notBefore === 'string' && ISO_DATE.test(c.notBefore) &&
    typeof c.notAfter === 'string' && ISO_DATE.test(c.notAfter) &&
    Array.isArray(c.keyUsage) && c.keyUsage.every((k) => typeof k === 'string') &&
    typeof c.signature === 'string'
  );
}

function fail(
  opts: VerifyOptions,
  evaluatedAt: Date,
  code: FailureCode,
  message: string,
  linkIndex: number | null,
  links: LinkReport[],
): VerifyResult {
  return {
    ok: false,
    runId: opts.runId,
    evaluatedAt: evaluatedAt.toISOString(),
    code,
    message,
    linkIndex,
    links,
  };
}

// Pure verification kernel: no I/O, fully determined by (input, clock, opts).
// Per-link check order: self-sign rules -> linkage -> signature -> validity.
export function verifyChain(input: unknown, clock: VirtualClock, opts: VerifyOptions): VerifyResult {
  const now = clock.now();
  const partial: LinkReport[] = [];

  if (typeof input !== 'object' || input === null || !Array.isArray((input as VerifyInput).chain)) {
    return fail(opts, now, 'INPUT_INVALID', 'request body must be an object with a "chain" array', null, partial);
  }
  const { chain } = input as VerifyInput;

  if (chain.length === 0) {
    return fail(opts, now, 'INPUT_INVALID', 'chain must contain at least one certificate', null, partial);
  }
  if (chain.length > opts.maxChainLength) {
    return fail(
      opts, now, 'CHAIN_TOO_LONG',
      `chain length ${chain.length} exceeds limit ${opts.maxChainLength}`, null, partial,
    );
  }
  for (let i = 0; i < chain.length; i++) {
    if (!validateCertificateShape(chain[i])) {
      return fail(opts, now, 'INPUT_INVALID', `certificate at index ${i} fails contract validation`, i, partial);
    }
  }

  const lastIndex = chain.length - 1;

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    const isRoot = i === lastIndex;
    const notBefore = new Date(cert.notBefore);
    const notAfter = new Date(cert.notAfter);

    // 1. Self-sign rules: intermediates must not be self-signed; root must be.
    if (!isRoot && i > 0 && cert.subject === cert.issuer) {
      return fail(opts, now, 'INTERMEDIATE_SELF_SIGNED', `link ${i}: intermediate certificate is self-signed`, i, partial);
    }
    if (isRoot && cert.subject !== cert.issuer) {
      return fail(opts, now, 'ROOT_NOT_SELF_SIGNED', `link ${i}: root certificate is not self-signed`, i, partial);
    }
    if (isRoot && !opts.trustedRoots.includes(cert.subject)) {
      return fail(opts, now, 'ROOT_UNTRUSTED', `link ${i}: root "${cert.subject}" is not in the trust store`, i, partial);
    }

    // 2. Linkage: issuer of link i must equal subject of link i+1 (root: itself).
    if (!isRoot && cert.issuer !== chain[i + 1].subject) {
      return fail(
        opts, now, 'CHAIN_LINK_MISMATCH',
        `link ${i}: issuer "${cert.issuer}" does not match subject "${chain[i + 1].subject}" of link ${i + 1}`,
        i, partial,
      );
    }

    // 3. Signature check (HMAC-SHA256 under the issuer's simulated CA key).
    const signatureValid = verifySignature(opts.masterSecret, cert);
    if (!signatureValid) {
      return fail(opts, now, 'SIGNATURE_INVALID', `link ${i}: signature of "${cert.subject}" does not verify`, i, partial);
    }

    // 4. Validity window: [notBefore, notAfter) — a cert is expired AT notAfter.
    const problems: FailureCode[] = [];
    if (now.getTime() < notBefore.getTime()) problems.push('CERT_NOT_YET_VALID');
    if (now.getTime() >= notAfter.getTime()) problems.push('CERT_EXPIRED');

    const remaining = remainingDays(notAfter, now);
    const report: LinkReport = {
      index: i,
      serial: cert.serial,
      subject: cert.subject,
      issuer: cert.issuer,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      signatureValid,
      inValidityWindow: problems.length === 0,
      remainingDays: remaining,
      renewalAction: renewalActionFor(remaining, opts.policy),
      problems,
    };
    partial.push(report);

    if (problems.includes('CERT_NOT_YET_VALID')) {
      return fail(opts, now, 'CERT_NOT_YET_VALID', `link ${i}: "${cert.subject}" is not valid before ${cert.notBefore}`, i, partial);
    }
    if (problems.includes('CERT_EXPIRED')) {
      return fail(opts, now, 'CERT_EXPIRED', `link ${i}: "${cert.subject}" expired at ${cert.notAfter}`, i, partial);
    }
  }

  return {
    ok: true,
    runId: opts.runId,
    evaluatedAt: now.toISOString(),
    chainLength: chain.length,
    links: partial,
    renewalAdvice: partial.map((l) => ({
      serial: l.serial,
      subject: l.subject,
      remainingDays: l.remainingDays,
      action: l.renewalAction,
    })),
  };
}

