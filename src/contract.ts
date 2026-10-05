import { AppError } from './errors.ts';

export type TestOutcome = 'pass' | 'fail';

export interface ScriptedTestSpec {
  kind: 'scripted';
  name: string;
  outcomes: TestOutcome[];
}

export interface CommandTestSpec {
  kind: 'command';
  name: string;
  command: string;
}

export type TestSpec = ScriptedTestSpec | CommandTestSpec;

export interface RunRequest {
  suiteId: string;
  runs: number;
  tests: TestSpec[];
}

export interface Limits {
  maxRuns: number;
  maxTestsPerSuite: number;
}

export function parseRunRequest(raw: unknown, limits: Limits): RunRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('INPUT_ERROR', 'request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.suiteId !== 'string' || obj.suiteId.trim() === '') {
    throw new AppError('INPUT_ERROR', 'suiteId must be a non-empty string', { field: 'suiteId' });
  }
  if (typeof obj.runs !== 'number' || !Number.isInteger(obj.runs) || obj.runs < 1) {
    throw new AppError('INPUT_ERROR', 'runs must be a positive integer', { field: 'runs', got: obj.runs });
  }
  if (obj.runs > limits.maxRuns) {
    throw new AppError('RESOURCE_EXHAUSTED', 'runs exceeds configured maximum', {
      field: 'runs',
      got: obj.runs,
      max: limits.maxRuns,
    });
  }
  if (!Array.isArray(obj.tests) || obj.tests.length === 0) {
    throw new AppError('INPUT_ERROR', 'tests must be a non-empty array', { field: 'tests' });
  }
  if (obj.tests.length > limits.maxTestsPerSuite) {
    throw new AppError('RESOURCE_EXHAUSTED', 'too many tests in one suite', {
      field: 'tests',
      got: obj.tests.length,
      max: limits.maxTestsPerSuite,
    });
  }

  const seen = new Set<string>();
  const tests = obj.tests.map((t, i) => parseTestSpec(t, i, seen));
  return { suiteId: obj.suiteId, runs: obj.runs, tests };
}

function parseTestSpec(raw: unknown, index: number, seen: Set<string>): TestSpec {
  const where = 'tests[' + index + ']';
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('INPUT_ERROR', where + ' must be an object', { field: where });
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== 'string' || t.name.trim() === '') {
    throw new AppError('INPUT_ERROR', where + '.name must be a non-empty string', { field: where + '.name' });
  }
  if (seen.has(t.name)) {
    throw new AppError('INPUT_ERROR', 'duplicate test name: ' + t.name, { field: where + '.name' });
  }
  seen.add(t.name);

  if (t.kind === 'scripted') {
    if (!Array.isArray(t.outcomes) || t.outcomes.length === 0) {
      throw new AppError('INPUT_ERROR', where + '.outcomes must be a non-empty array of pass|fail', {
        field: where + '.outcomes',
      });
    }
    for (const o of t.outcomes) {
      if (o !== 'pass' && o !== 'fail') {
        throw new AppError('INPUT_ERROR', where + '.outcomes contains invalid outcome: ' + String(o), {
          field: where + '.outcomes',
        });
      }
    }
    return { kind: 'scripted', name: t.name, outcomes: t.outcomes as TestOutcome[] };
  }
  if (t.kind === 'command') {
    if (typeof t.command !== 'string' || t.command.trim() === '') {
      throw new AppError('INPUT_ERROR', where + '.command must be a non-empty string', { field: where + '.command' });
    }
    return { kind: 'command', name: t.name, command: t.command };
  }
  throw new AppError('INPUT_ERROR', where + '.kind must be scripted or command', { field: where + '.kind', got: t.kind });
}
