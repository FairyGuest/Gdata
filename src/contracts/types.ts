export type Severity = 'error' | 'warning' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export type AstNodeType =
  | 'FunctionDeclaration'
  | 'ImportStatement'
  | 'StringLiteral';

export type RuleMatch =
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'ast'; nodeType: AstNodeType; pattern?: string };

export interface Rule {
  name: string;
  enabled: boolean;
  severity: Severity;
  message: string;
  match: RuleMatch;
}

export interface Violation {
  file: string;
  line: number;
  column: number;
  rule: string;
  severity: Severity;
  message: string;
  snippet: string;
}

export interface AstNode {
  type: AstNodeType;
  line: number;
  column: number;
  text: string;
}

export interface EngineLimits {
  maxSourceBytes: number;
  maxRules: number;
  maxMatchesPerRule: number;
}

export interface EngineLogEntry {
  step: string;
  detail: string;
}

export interface CheckResult {
  runId: string;
  file: string;
  violations: Violation[];
  log: EngineLogEntry[];
}

export interface DiffResult {
  fromRunId: string;
  toRunId: string;
  added: Violation[];
  removed: Violation[];
}

