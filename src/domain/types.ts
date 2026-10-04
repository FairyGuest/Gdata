export interface Certificate {
  serial: string;
  subject: string;
  issuer: string;
  notBefore: string; // ISO-8601
  notAfter: string;  // ISO-8601, exclusive upper bound
  keyUsage: string[];
  signature: string; // HMAC-SHA256 hex, produced by the issuer's key
}

export type FailureCode =
  | 'INPUT_INVALID'
  | 'CHAIN_LINK_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'INTERMEDIATE_SELF_SIGNED'
  | 'ROOT_NOT_SELF_SIGNED'
  | 'ROOT_UNTRUSTED'
  | 'CERT_EXPIRED'
  | 'CERT_NOT_YET_VALID'
  | 'CHAIN_TOO_LONG'
  | 'STATE_CONFLICT'
  | 'STATE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type RenewalAction = 'NONE' | 'RENEW_SOON' | 'RENEW_IMMEDIATELY';

export interface LinkReport {
  index: number;
  serial: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  signatureValid: boolean;
  inValidityWindow: boolean;
  remainingDays: number;
  renewalAction: RenewalAction;
  problems: FailureCode[];
}

export interface RenewalAdvice {
  serial: string;
  subject: string;
  remainingDays: number;
  action: RenewalAction;
}

export interface VerifySuccess {
  ok: true;
  runId: string;
  evaluatedAt: string;
  chainLength: number;
  links: LinkReport[];
  renewalAdvice: RenewalAdvice[];
}

export interface VerifyFailure {
  ok: false;
  runId: string;
  evaluatedAt: string;
  code: FailureCode;
  message: string;
  linkIndex: number | null;
  links: LinkReport[];
}

export type VerifyResult = VerifySuccess | VerifyFailure;

export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly linkIndex: number | null = null,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

