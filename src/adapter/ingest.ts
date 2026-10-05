import { ContractError } from '../errors.js';
import type { IngestRequest, RawTestRun, TestCase, TestStatus } from '../contract/types.js';

const STATUS_ALIASES: Record<string, TestStatus> = {
  passed: 'passed', pass: 'passed', ok: 'passed', success: 'passed',
  failed: 'failed', fail: 'failed', failure: 'failed', error: 'failed',
  skipped: 'skipped', skip: 'skipped', pending: 'skipped', ignored: 'skipped',
};

export function normalizeStatus(raw: unknown): TestStatus {
  if (typeof raw !== 'string') {
    throw new ContractError('UNKNOWN_STATUS', 'status must be a string', { status: raw });
  }
  const normalized = STATUS_ALIASES[raw.trim().toLowerCase()];
  if (!normalized) {
    throw new ContractError('UNKNOWN_STATUS', 'unknown test status: ' + raw, { status: raw });
  }
  return normalized;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ContractError('MISSING_FIELD', 'missing or invalid field: ' + field, { field });
  }
  return value;
}

function requireDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ContractError('INVALID_PAYLOAD', 'invalid durationMs for ' + field, { field });
  }
  return value;
}

/** Validates the raw request body and normalizes every case. */
export function parseIngestRequest(body: unknown): { label: string | null; cases: TestCase[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ContractError('INVALID_PAYLOAD', 'request body must be an object');
  }
  const request = body as Partial<IngestRequest>;
  if (!Array.isArray(request.runs) || request.runs.length === 0) {
    throw new ContractError('MISSING_FIELD', 'runs must be a non-empty array', { field: 'runs' });
  }
  let label: string | null = null;
  if (request.label !== undefined) {
    if (typeof request.label !== 'string') {
      throw new ContractError('INVALID_PAYLOAD', 'label must be a string', { field: 'label' });
    }
    label = request.label;
  }
  const cases: TestCase[] = [];
  for (const [runIndex, run] of request.runs.entries()) {
    cases.push(...parseRun(run, runIndex));
  }
  return { label, cases };
}

function parseRun(run: unknown, runIndex: number): TestCase[] {
  const where = 'runs[' + runIndex + ']';
  if (typeof run !== 'object' || run === null) {
    throw new ContractError('INVALID_PAYLOAD', where + ' must be an object');
  }
  const raw = run as Partial<RawTestRun>;
  const runId = requireString(raw.runId, where + '.runId');
  if (!Array.isArray(raw.cases)) {
    throw new ContractError('MISSING_FIELD', where + '.cases must be an array', { field: where + '.cases' });
  }
  return raw.cases.map((rawCase, caseIndex) => {
    const at = where + '.cases[' + caseIndex + ']';
    if (typeof rawCase !== 'object' || rawCase === null) {
      throw new ContractError('INVALID_PAYLOAD', at + ' must be an object');
    }
    const file = requireString(rawCase.file, at + '.file');
    const name = requireString(rawCase.name, at + '.name');
    return {
      key: file + '::' + name,
      file,
      name,
      status: normalizeStatus(rawCase.status),
      durationMs: requireDuration(rawCase.durationMs, at),
      runId,
    };
  });
}
