import type { ErrorCategory } from "./errors.ts";

export interface ClientRegistration {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface AuthorizeRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  state?: string;
}

export interface AuthorizeResult {
  code: string;
  redirectUri: string;
  state?: string;
  expiresInMs: number;
}

export interface TokenRequest {
  grantType: string;
  code?: string;
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  codeVerifier?: string;
  refreshToken?: string;
}

export interface TokenResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresInMs: number;
  refreshToken: string;
  scope: string;
}

export interface IntrospectResult {
  active: boolean;
  clientId?: string;
  scope?: string;
  expiresAt?: number;
  reason?: string;
}

export interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface TokenRecord {
  token: string;
  kind: "access" | "refresh";
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  familyId: string;
}

export type Decision =
  | { ok: true }
  | { ok: false; error: string; category: ErrorCategory; reason: string };

export interface AuditEvent {
  runId: string;
  seq: number;
  at: number;
  action: string;
  outcome: "success" | "failure";
  reason: string;
  detail: Record<string, unknown>;
}
