/**
 * Contract layer: parses and validates inbound payloads into typed
 * commands the kernel accepts. Anything malformed is rejected here with
 * VALIDATION_ERROR; the kernel never sees untyped input.
 */
import { validationError } from './errors.ts';

export interface IssueCommand {
  subject: string;
  ttlSeconds: number;
  scopes: string[];
}

export interface TokenCommand {
  token: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SCOPE_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/;

export function parseIssue(body: unknown, maxTtlSeconds: number): IssueCommand {
  if (!isRecord(body)) {
    throw validationError('request body must be a JSON object', { received: body });
  }
  const { subject, ttlSeconds, scopes } = body;
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 128) {
    throw validationError('subject must be a non-empty string of at most 128 chars');
  }
  if (
    typeof ttlSeconds !== 'number' ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > maxTtlSeconds
  ) {
    throw validationError('ttlSeconds must be an integer in (0, ' + maxTtlSeconds + ']', {
      received: ttlSeconds,
    });
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32) {
    throw validationError('scopes must be a non-empty array of at most 32 entries');
  }
  for (const s of scopes) {
    if (typeof s !== 'string' || !SCOPE_PATTERN.test(s)) {
      throw validationError('invalid scope: ' + JSON.stringify(s), {
        pattern: SCOPE_PATTERN.source,
      });
    }
  }
  if (new Set(scopes).size !== scopes.length) {
    throw validationError('scopes must not contain duplicates');
  }
  return { subject, ttlSeconds, scopes: scopes as string[] };
}

export function parseTokenBody(body: unknown): TokenCommand {
  if (!isRecord(body) || typeof body.token !== 'string' || body.token.length === 0) {
    throw validationError('request body must be an object with a non-empty string field "token"');
  }
  if (body.token.length > 8192) {
    throw validationError('token exceeds maximum accepted length of 8192 chars');
  }
  return { token: body.token };
}
