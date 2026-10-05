// Execution kernel: evaluates a rule set over source files and produces a
// deterministically ordered violation list.
import { createHash } from 'node:crypto';
import {
  SEVERITY_RANK,
  type CheckResult,
  type EngineLimits,
  type Rule,
  type SourceFile,
  type Violation,
} from '../contracts/types.ts';
import { EngineError } from '../contracts/errors.ts';
import type { RunLogger } from '../contracts/logger.ts';
import { parseSource } from './parser.ts';
import { matchNodeRule, matchRegexRule, validateRule } from './matcher.ts';

export function fingerprint(v: Omit<Violation, 'fingerprint'>): string {
  return createHash('sha1')
    .update([v.file, v.line, v.column, v.rule, v.excerpt].join(''))
    .digest('hex')
    .slice(0, 16);
}

export function compareViolations(a: Violation, b: Violation): number {
  return (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || // same position: severity desc
    a.rule.localeCompare(b.rule)
  );
}

export interface EngineOptions {
  limits: EngineLimits;
  logger?: RunLogger;
}

export class LintEngine {
  private readonly limits: EngineLimits;
  private readonly logger?: RunLogger;
  constructor(opts: EngineOptions) {
    this.limits = opts.limits;
    this.logger = opts.logger;
  }

  check(files: SourceFile[], rawRules: Rule[], runId: number | null = null): CheckResult {
    if (!Array.isArray(files) || files.length === 0) {
      throw new EngineError('INPUT_ERROR', 'check requires a non-empty files array');
    }
    if (files.length > this.limits.maxFilesPerCheck) {
      throw new EngineError(
        'RESOURCE_EXHAUSTED',
        `too many files: ${files.length} > maxFilesPerCheck=${this.limits.maxFilesPerCheck}`,
      );
    }
    if (rawRules.length > this.limits.maxRules) {
      throw new EngineError('RESOURCE_EXHAUSTED', `too many rules: ${rawRules.length} > maxRules=${this.limits.maxRules}`);
    }
    const rules = rawRules.map((r) => validateRule(r));
    const active = rules.filter((r) => r.enabled);
    this.logger?.log('check.start', `files=${files.length} rules=${rules.length} enabled=${active.length}`);

    const violations: Violation[] = [];
    for (const file of files) {
      if (typeof file.path !== 'string' || file.path === '') {
        throw new EngineError('INPUT_ERROR', 'each file requires a non-empty path');
      }
      if (typeof file.content !== 'string') {
        throw new EngineError('INPUT_ERROR', `file ${file.path}: content must be a string`);
      }
      const bytes = Buffer.byteLength(file.content, 'utf8');
      if (bytes > this.limits.maxSourceBytes) {
        throw new EngineError(
          'RESOURCE_EXHAUSTED',
          `file ${file.path}: ${bytes} bytes > maxSourceBytes=${this.limits.maxSourceBytes}`,
        );
      }
      const nodes = parseSource(file.path, file.content);
      this.logger?.log('parse', `${file.path}: ${nodes.length} nodes`);
      for (const rule of active) {
        const matches =
          rule.target.kind === 'regex'
            ? matchRegexRule(rule, file.content, this.limits)
            : matchNodeRule(rule, nodes, this.limits);
        if (matches.length > 0) {
          this.logger?.log('rule.hit', `${file.path} rule=${rule.name} hits=${matches.length}`, rule.message);
        }
        for (const m of matches) {
          const base = {
            file: file.path,
            line: m.line,
            column: m.column,
            rule: rule.name,
            severity: rule.severity,
            message: rule.message ?? `rule ${rule.name} matched`,
            excerpt: m.excerpt,
          };
          violations.push({ ...base, fingerprint: fingerprint(base) });
        }
      }
    }
    violations.sort(compareViolations);
    this.logger?.log('check.done', `runId=${String(runId)} violations=${violations.length}`);
    return { runId, violations, filesChecked: files.length, rulesEvaluated: active.length };
  }
}
