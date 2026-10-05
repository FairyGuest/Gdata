// Data contracts shared across all engine boundaries.
// Every module speaks these types; nothing module-internal leaks across.

export const SEVERITIES = ['error', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

// Higher rank = more severe. Used for same-position ordering.
export const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export type RuleTarget =
  | { kind: 'regex'; pattern: string }
  | { kind: 'node'; nodeType: NodeType; pattern?: string };

export interface Rule {
  name: string;
  enabled: boolean;
  severity: Severity;
  target: RuleTarget;
  message?: string;
}

export type NodeType =
  | 'function_declaration'
  | 'arrow_function'
  | 'import_statement'
  | 'export_statement'
  | 'string_literal'
  | 'variable_declaration'
  | 'class_declaration'
  | 'interface_declaration'
  | 'call_expression'
  | 'comment';

export const NODE_TYPES: NodeType[] = [
  'function_declaration',
  'arrow_function',
  'import_statement',
  'export_statement',
  'string_literal',
  'variable_declaration',
  'class_declaration',
  'interface_declaration',
  'call_expression',
  'comment',
];

// A lightweight AST node produced by the parser.
export interface AstNode {
  type: NodeType;
  line: number; // 1-based
  column: number; // 1-based
  text: string; // source excerpt of the node (single line trimmed)
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface Violation {
  file: string;
  line: number;
  column: number;
  rule: string;
  severity: Severity;
  message: string;
  excerpt: string;
  fingerprint: string;
}

export interface CheckResult {
  runId: number | null; // null when not persisted
  violations: Violation[];
  filesChecked: number;
  rulesEvaluated: number;
}

export interface RunSummary {
  id: number;
  createdAt: string;
  status: 'completed' | 'failed';
  filesChecked: number;
  violationCount: number;
}

export interface RunDiff {
  fromRunId: number;
  toRunId: number;
  added: Violation[];
  removed: Violation[];
}

export interface EngineLimits {
  maxSourceBytes: number;
  maxFilesPerCheck: number;
  maxMatchesPerRule: number;
  maxRules: number;
}

export interface EngineConfig {
  port: number;
  host: string;
  dbPath: string;
  logDir: string;
  limits: EngineLimits;
}
