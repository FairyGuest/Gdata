// Rule validation + matching primitives. Pure functions, no I/O.
import {
  NODE_TYPES,
  SEVERITIES,
  type AstNode,
  type EngineLimits,
  type Rule,
  type Severity,
} from '../contracts/types.ts';
import { EngineError } from '../contracts/errors.ts';

export function validateRule(raw: unknown): Rule {
  if (typeof raw !== 'object' || raw === null) {
    throw new EngineError('INPUT_ERROR', 'rule must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.trim() === '') {
    throw new EngineError('INPUT_ERROR', 'rule.name must be a non-empty string');
  }
  if (!SEVERITIES.includes(r.severity as Severity)) {
    throw new EngineError('INPUT_ERROR', `rule "${r.name}": severity must be one of ${SEVERITIES.join(', ')}`);
  }
  const target = r.target as Record<string, unknown> | undefined;
  if (typeof target !== 'object' || target === null) {
    throw new EngineError('INPUT_ERROR', `rule "${r.name}": target is required`);
  }
  if (target.kind === 'regex') {
    if (typeof target.pattern !== 'string' || target.pattern === '') {
      throw new EngineError('INPUT_ERROR', `rule "${r.name}": regex target requires a pattern`);
    }
    compileRegex(target.pattern, r.name as string);
  } else if (target.kind === 'node') {
    if (!NODE_TYPES.includes(target.nodeType as never)) {
      throw new EngineError(
        'INPUT_ERROR',
        `rule "${r.name}": unknown nodeType "${String(target.nodeType)}"; allowed: ${NODE_TYPES.join(', ')}`,
      );
    }
    if (target.pattern !== undefined) compileRegex(String(target.pattern), r.name as string);
  } else {
    throw new EngineError('INPUT_ERROR', `rule "${r.name}": target.kind must be "regex" or "node"`);
  }
  if (r.message !== undefined && typeof r.message !== 'string') {
    throw new EngineError('INPUT_ERROR', `rule "${r.name}": message must be a string`);
  }
  return {
    name: (r.name as string).trim(),
    enabled: r.enabled !== false,
    severity: r.severity as Severity,
    target: target as unknown as Rule['target'],
    ...(typeof r.message === 'string' ? { message: r.message } : {}),
  };
}

export function compileRegex(pattern: string, ruleName: string): RegExp {
  try {
    return new RegExp(pattern, 'gm');
  } catch (err) {
    throw new EngineError('INPUT_ERROR', `rule "${ruleName}": invalid regex ${JSON.stringify(pattern)}`, String(err));
  }
}

export interface RawMatch {
  line: number;
  column: number;
  excerpt: string;
}

function lineColAt(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, column: index - lineStart + 1 };
}

function lineExcerpt(source: string, line: number): string {
  const lines = source.split('\n');
  const text = (lines[line - 1] ?? '').trim();
  return text.length > 200 ? text.slice(0, 200) + '...' : text;
}

// Match a regex rule against whole source (multiline aware).
export function matchRegexRule(rule: Rule, source: string, limits: EngineLimits): RawMatch[] {
  if (rule.target.kind !== 'regex') return [];
  const rx = compileRegex(rule.target.pattern, rule.name);
  const out: RawMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) {
    const { line, column } = lineColAt(source, m.index);
    out.push({ line, column, excerpt: lineExcerpt(source, line) });
    if (out.length >= limits.maxMatchesPerRule) {
      throw new EngineError(
        'RESOURCE_EXHAUSTED',
        `rule "${rule.name}" exceeded maxMatchesPerRule=${limits.maxMatchesPerRule}`,
      );
    }
    if (m.index === rx.lastIndex) rx.lastIndex++; // guard against zero-width loops
  }
  return out;
}

// Match a node rule against parsed AST nodes.
export function matchNodeRule(rule: Rule, nodes: AstNode[], limits: EngineLimits): RawMatch[] {
  if (rule.target.kind !== 'node') return [];
  const { nodeType, pattern } = rule.target;
  const rx = pattern !== undefined ? compileRegex(pattern, rule.name) : null;
  const out: RawMatch[] = [];
  for (const node of nodes) {
    if (node.type !== nodeType) continue;
    if (rx && !rx.test(node.text)) continue;
    out.push({ line: node.line, column: node.column, excerpt: node.text });
    if (out.length >= limits.maxMatchesPerRule) {
      throw new EngineError(
        'RESOURCE_EXHAUSTED',
        `rule "${rule.name}" exceeded maxMatchesPerRule=${limits.maxMatchesPerRule}`,
      );
    }
  }
  return out;
}
