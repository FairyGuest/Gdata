// Orchestration: contract parsing -> mutant generation -> kernel execution ->
// scoring -> persistence. Enforces resource guards and state conflicts.
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mutant, RunRecord, RunRequest, RunSummary } from './contract/types.ts';
import { ServiceError } from './contract/errors.ts';
import { generateMutants } from './mutator/engine.ts';
import { Kernel, collectSourceFiles } from './runner/kernel.ts';
import type { MutationStore } from './store/sqlite.ts';
import type { ServiceConfig } from './config.ts';

const VALID_TYPES = new Set([
  'EqualityOperator', 'ArithmeticOperator', 'ConditionalBoundary', 'BooleanLiteral', 'RemoveCall',
]);

export function parseRunRequest(body: unknown, config: ServiceConfig): Required<RunRequest> {
  if (typeof body !== 'object' || body === null) {
    throw new ServiceError('INPUT_INVALID', 'Request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.projectDir !== 'string' || b.projectDir.length === 0) {
    throw new ServiceError('INPUT_INVALID', 'projectDir is required and must be a non-empty string');
  }
  const projectDir = resolve(b.projectDir);
  if (!statSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ServiceError('INPUT_INVALID', 'projectDir does not exist or is not a directory: ' + projectDir);
  }
  const testCommand = b.testCommand === undefined ? config.defaultTestCommand : b.testCommand;
  if (typeof testCommand !== 'string' || testCommand.trim() === '') {
    throw new ServiceError('INPUT_INVALID', 'testCommand must be a non-empty string');
  }
  const types = b.types === undefined ? undefined : b.types;
  if (types !== undefined) {
    if (!Array.isArray(types) || types.some((t) => typeof t !== 'string' || !VALID_TYPES.has(t as string))) {
      throw new ServiceError('INPUT_INVALID', 'types must be an array of valid mutation types',
        { valid: [...VALID_TYPES] });
    }
  }
  const files = b.files === undefined ? undefined : b.files;
  if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))) {
    throw new ServiceError('INPUT_INVALID', 'files must be an array of project-relative paths');
  }
  const maxMutants = b.maxMutants === undefined ? config.maxMutantsPerRun : Number(b.maxMutants);
  const timeoutMs = b.timeoutMs === undefined ? config.defaultTimeoutMs : Number(b.timeoutMs);
  if (!Number.isInteger(maxMutants) || maxMutants <= 0) {
    throw new ServiceError('INPUT_INVALID', 'maxMutants must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ServiceError('INPUT_INVALID', 'timeoutMs must be a positive integer');
  }
  return {
    projectDir,
    testCommand: testCommand as string,
    files: files as string[] | undefined,
    types: types as any,
    maxMutants,
    timeoutMs,
  } as Required<RunRequest>;
}

export class MutationService {
  private readonly activeProjects = new Set<string>();
  private readonly store: MutationStore;
  private readonly config: ServiceConfig;
  private readonly logger: (msg: string) => void;
  constructor(store: MutationStore, config: ServiceConfig, logger: (msg: string) => void = () => {}) {
    this.store = store;
    this.config = config;
    this.logger = logger;
  }

  async run(rawBody: unknown): Promise<RunRecord> {
    const req = parseRunRequest(rawBody, this.config);
    if (this.activeProjects.has(req.projectDir)) {
      throw new ServiceError('STATE_CONFLICT',
        'A mutation run is already in progress for ' + req.projectDir);
    }
    this.activeProjects.add(req.projectDir);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const allFiles = collectSourceFiles(req.projectDir);
      const files = req.files ? allFiles.filter((f) => req.files!.includes(f)) : allFiles;
      if (files.length === 0) {
        throw new ServiceError('INPUT_INVALID', 'No source files matched in projectDir',
          { available: allFiles });
      }
      const mutants: Mutant[] = [];
      for (const file of files) {
        const source = readFileSync(resolve(req.projectDir, file), 'utf8');
        mutants.push(...generateMutants(file, source, req.types));
      }
      this.logger('[service] run=' + runId + ' generated ' + mutants.length +
        ' mutants across ' + files.length + ' files');
      if (mutants.length > req.maxMutants) {
        throw new ServiceError('RESOURCE_EXHAUSTED',
          'Mutant count ' + mutants.length + ' exceeds budget ' + req.maxMutants,
          { mutants: mutants.length, maxMutants: req.maxMutants });
      }

      const kernel = new Kernel({
        testCommand: req.testCommand,
        timeoutMs: req.timeoutMs,
        outputTailChars: this.config.outputTailChars,
        executor: this.config.executor,
        logger: this.logger,
      });
      const results = [];
      for (const mutant of mutants) {
        // Yield to the event loop between mutants so concurrent requests and
        // timers are not starved by synchronous kernel work.
        await new Promise((r) => setImmediate(r));
        try {
          results.push(await kernel.execute(req.projectDir, mutant, runId));
        } catch (err) {
          if (err instanceof ServiceError && err.code === 'EXECUTION_FAILED') throw err;
          results.push({
            mutant,
            status: 'error' as const,
            durationMs: 0,
            reason: 'kernel error: ' + (err instanceof Error ? err.message : String(err)),
            testExitCode: null,
            testOutputTail: '',
          });
        }
      }
      const killed = results.filter((r) => r.status === 'killed' || r.status === 'timeout').length;
      const survived = results.filter((r) => r.status === 'survived').length;
      const timeouts = results.filter((r) => r.status === 'timeout').length;
      const errors = results.filter((r) => r.status === 'error').length;
      const total = results.length;
      const score = total === 0 ? 0 : killed / total;
      const record: RunRecord = {
        runId,
        projectDir: req.projectDir,
        startedAt,
        finishedAt: new Date().toISOString(),
        total,
        killed,
        survived,
        timeouts,
        errors,
        score: Math.round(score * 10000) / 10000,
        survivors: results.filter((r) => r.status === 'survived').map((r) => r.mutant),
        results,
      };
      this.store.saveRun(record);
      this.logger('[service] run=' + runId + ' finished score=' + record.score +
        ' killed=' + killed + ' survived=' + survived + ' errors=' + errors);
      return record;
    } finally {
      this.activeProjects.delete(req.projectDir);
    }
  }

  getRun(runId: string): RunRecord {
    return this.store.getRun(runId);
  }

  listRuns(): RunSummary[] {
    return this.store.listRuns();
  }

  queryMutants(filter: { file?: string; type?: string; status?: string }) {
    if (filter.type && !VALID_TYPES.has(filter.type)) {
      throw new ServiceError('INPUT_INVALID', 'Unknown mutation type: ' + filter.type,
        { valid: [...VALID_TYPES] });
    }
    if (filter.status && !['killed', 'survived', 'timeout', 'error'].includes(filter.status)) {
      throw new ServiceError('INPUT_INVALID', 'Unknown status: ' + filter.status);
    }
    return this.store.queryMutants(filter);
  }
}

