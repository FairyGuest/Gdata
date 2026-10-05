import { EngineError } from '../contracts/errors.ts';
import {
  SEVERITY_RANK,
  type CheckResult,
  type EngineLimits,
  type EngineLogEntry,
  type Rule,
  type Violation,
} from '../contracts/types.ts';
import { scanSource, SUPPORTED_NODE_TYPES } from './scanner.ts';

export const DEFAULT_LIMITS: EngineLimits = {
  maxSourceBytes: 256 * 1024,
  maxRules: 200,
  maxMatchesPerRule: 1000,
};

const SEVERITIES = new Set(['error', 'warning', 'info']);

export function validateRule(rule: unknown, index: number): Rule {
  const where = 'rule[' + index + ']';
  if (typeof rule !== 'object' || rule === null) {
    throw new EngineError('INPUT_ERROR', 'RULE_NOT_OBJECT', where + ' must be an object');
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.trim() === '') {
    throw new EngineError('INPUT_ERROR', 'RULE_NAME_INVALID', where + '.name must be a non-empty string');
  }
  if (typeof r.enabled !== 'boolean') {
    throw new EngineError('INPUT_ERROR', 'RULE_ENABLED_INVALID', where + '.enabled must be a boolean');
  }
  if (typeof r.severity !== 'string' || !SEVERITIES.has(r.severity)) {
    throw new EngineError('INPUT_ERROR', 'RULE_SEVERITY_INVALID', where + '.severity must be error|warning|info');
  }
  if (typeof r.message !== 'string') {
    throw new EngineError('INPUT_ERROR', 'RULE_MESSAGE_INVALID', where + '.message must be a string');
  }
  const match = r.match as Record<string, unknown> | undefined;
  if (typeof match !== 'object' || match === null) {
    throw new EngineError('INPUT_ERROR', 'RULE_MATCH_INVALID', where + '.match must be an object');
  }
  if (match.kind === 'regex') {
    if (typeof match.pattern !== 'string' || match.pattern === '') {
      throw new EngineError('INPUT_ERROR', 'RULE_PATTERN_INVALID', where + '.match.pattern must be a non-empty string');
    }
    const flags = typeof match.flags === 'string' ? match.flags : '';
    try {
      new RegExp(match.pattern, flags);
    } catch (e) {
      throw new EngineError('INPUT_ERROR', 'RULE_REGEX_INVALID', where + '.match.pattern is not a valid regex: ' + (e as Error).message);
    }
  } else if (match.kind === 'ast') {
    if (typeof match.nodeType !== 'string' || !SUPPORTED_NODE_TYPES.includes(match.nodeType as never)) {
      throw new EngineError('INPUT_ERROR', 'RULE_NODETYPE_INVALID', where + '.match.nodeType must be one of ' + SUPPORTED_NODE_TYPES.join(', '));
    }
    if (match.pattern !== undefined) {
      try {
        new RegExp(String(match.pattern));
      } catch (e) {
        throw new EngineError('INPUT_ERROR', 'RULE_REGEX_INVALID', where + '.match.pattern is not a valid regex: ' + (e as Error).message);
      }
    }
  } else {
    throw new EngineError('INPUT_ERROR', 'RULE_KIND_INVALID', where + '.match.kind must be regex|ast');
  }
  return rule as Rule;
}

export function validateRuleSet(rules: unknown[]): Rule[] {
  const seen = new Set<string>();
  const out: Rule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = validateRule(rules[i], i);
    if (seen.has(r.name)) {
      throw new EngineError('STATE_CONFLICT', 'RULE_DUPLICATE', 'duplicate rule name: ' + r.name);
    }
    seen.add(r.name);
    out.push(r);
  }
  return out;
}

let runCounter = 0;
export function nextRunId(): string {
  runCounter += 1;
  return 'run-' + Date.now().toString(36) + '-' + runCounter;
}

function lineColAt(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      last = i;
    }
  }
  return { line, column: index - last };
}

export function runCheck(
  file: string,
  source: string,
  rules: Rule[],
  limits: EngineLimits = DEFAULT_LIMITS,
): CheckResult {
  const log: EngineLogEntry[] = [];
  const runId = nextRunId();
  log.push({ step: 'start', detail: 'runId=' + runId + ' file=' + file + ' bytes=' + source.length });

  if (typeof file !== 'string' || file.trim() === '') {
    throw new EngineError('INPUT_ERROR', 'FILE_INVALID', 'file must be a non-empty string');
  }
  if (typeof source !== 'string') {
    throw new EngineError('INPUT_ERROR', 'SOURCE_INVALID', 'source must be a string');
  }
  if (Buffer.byteLength(source, 'utf8') > limits.maxSourceBytes) {
    throw new EngineError('RESOURCE_EXHAUSTED', 'SOURCE_TOO_LARGE', 'source exceeds maxSourceBytes=' + limits.maxSourceBytes);
  }
  if (rules.length > limits.maxRules) {
    throw new EngineError('RESOURCE_EXHAUSTED', 'TOO_MANY_RULES', 'rule count ' + rules.length + ' exceeds maxRules=' + limits.maxRules);
  }

  const active = rules.filter((r) => r.enabled);
  log.push({ step: 'rules', detail: 'total=' + rules.length + ' enabled=' + active.length + ' disabled=' + (rules.length - active.length) });

  const needAst = active.some((r) => r.match.kind === 'ast');
  const nodes = needAst ? scanSource(source) : [];
  if (needAst) {
    log.push({ step: 'scan', detail: 'astNodes=' + nodes.length });
  }

  const violations: Violation[] = [];
  for (const rule of active) {
    let count = 0;
    if (rule.match.kind === 'regex') {
      const flags = rule.match.flags ?? '';
      const gflags = flags.includes('g') ? flags : flags + 'g';
      let re: RegExp;
      try {
        re = new RegExp(rule.match.pattern, gflags);
      } catch (e) {
        throw new EngineError('COMPUTATION_ERROR', 'REGEX_COMPILE_FAILED', 'rule ' + rule.name + ': ' + (e as Error).message);
      }
      let m: RegExpExecArray | null;
      try {
        while ((m = re.exec(source)) !== null) {
          if (m[0].length === 0) re.lastIndex += 1;
          const pos = lineColAt(source, m.index);
          violations.push({
            file,
            line: pos.line,
            column: pos.column,
            rule: rule.name,
            severity: rule.severity,
            message: rule.message,
            snippet: m[0].slice(0, 120),
          });
          count += 1;
          if (count >= limits.maxMatchesPerRule) {
            throw new EngineError('RESOURCE_EXHAUSTED', 'TOO_MANY_MATCHES', 'rule ' + rule.name + ' exceeded maxMatchesPerRule=' + limits.maxMatchesPerRule);
          }
        }
      } catch (e) {
        if (e instanceof EngineError) throw e;
        throw new EngineError('COMPUTATION_ERROR', 'REGEX_EXEC_FAILED', 'rule ' + rule.name + ': ' + (e as Error).message);
      }
    } else {
      const pat = rule.match.pattern !== undefined ? new RegExp(rule.match.pattern) : null;
      for (const node of nodes) {
        if (node.type !== rule.match.nodeType) continue;
        if (pat && !pat.test(node.text)) continue;
        violations.push({
          file,
          line: node.line,
          column: node.column,
          rule: rule.name,
          severity: rule.severity,
          message: rule.message,
          snippet: node.text.slice(0, 120),
        });
        count += 1;
        if (count >= limits.maxMatchesPerRule) {
          throw new EngineError('RESOURCE_EXHAUSTED', 'TOO_MANY_MATCHES', 'rule ' + rule.name + ' exceeded maxMatchesPerRule=' + limits.maxMatchesPerRule);
        }
      }
    }
    log.push({ step: 'rule', detail: rule.name + ' kind=' + rule.match.kind + ' severity=' + rule.severity + ' matches=' + count });
  }

  violations.sort((a, b) =>
    a.line - b.line ||
    a.column - b.column ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.rule.localeCompare(b.rule),
  );
  log.push({ step: 'sort', detail: 'by (line, column, severity desc, rule); violations=' + violations.length });
  log.push({ step: 'done', detail: 'runId=' + runId + ' violations=' + violations.length });

  return { runId, file, violations, log };
}

