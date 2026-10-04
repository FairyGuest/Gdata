import { VaultError } from './errors.js';

export interface WriteRequest {
  name: string;
  value: string;
  runId?: string;
}

export interface ReadRequest {
  name: string;
  version?: number;
  runId?: string;
}

export interface RotateRequest {
  name: string;
  runId?: string;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function parseName(raw: unknown): string {
  if (typeof raw !== 'string' || !NAME_PATTERN.test(raw)) {
    throw new VaultError('VALIDATION', 'secret name must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$', {
      received: typeof raw === 'string' ? raw : typeof raw,
    });
  }
  return raw;
}

export function parseValue(raw: unknown, maxValueBytes: number): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new VaultError('VALIDATION', 'value must be a non-empty string');
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > maxValueBytes) {
    throw new VaultError('RESOURCE_EXHAUSTED', 'value exceeds configured maxValueBytes', {
      bytes,
      maxValueBytes,
    });
  }
  return raw;
}

export function parseVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new VaultError('VALIDATION', 'version must be a positive integer', { received: raw });
  }
  return n;
}

export function parseWriteBody(body: unknown, maxValueBytes: number): { name?: string; value: string } {
  if (typeof body !== 'object' || body === null) {
    throw new VaultError('VALIDATION', 'request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const out: { name?: string; value: string } = { value: parseValue(b.value, maxValueBytes) };
  if (b.name !== undefined) out.name = parseName(b.name);
  return out;
}
