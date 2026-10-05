// Lightweight structural parser for TypeScript source.
// Not a full TS compiler: a tokenizer pass strips strings/comments into nodes,
// then statement-level patterns recognize common declaration node types.
import type { AstNode, NodeType } from '../contracts/types.ts';
import { EngineError } from '../contracts/errors.ts';

interface Token {
  kind: 'string' | 'comment';
  line: number;
  column: number;
  text: string;
}

function tokenize(source: string): { tokens: Token[]; masked: string } {
  const tokens: Token[] = [];
  const chars = source.split('');
  let line = 1;
  let lineStart = 0;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') { line++; lineStart = i + 1; i++; continue; }
    // line comment
    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      tokens.push({ kind: 'comment', line, column: start - lineStart + 1, text: source.slice(start, i) });
      for (let k = start; k < i; k++) chars[k] = ' ';
      continue;
    }
    // block comment
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      const startLine = line;
      const startCol = start - lineStart + 1;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      i = Math.min(i + 2, n);
      tokens.push({ kind: 'comment', line: startLine, column: startCol, text: source.slice(start, i) });
      for (let k = start; k < i; k++) if (chars[k] !== '\n') chars[k] = ' ';
      continue;
    }
    // string literals
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      const startLine = line;
      const startCol = start - lineStart + 1;
      i++;
      while (i < n) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { i++; break; }
        if (c === '\n' && quote !== '`') break; // unterminated; bail at EOL
        if (c === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      tokens.push({ kind: 'string', line: startLine, column: startCol, text: source.slice(start, i) });
      for (let k = start; k < i; k++) if (chars[k] !== '\n') chars[k] = ' ';
      continue;
    }
    i++;
  }
  return { tokens, masked: chars.join('') };
}

const STATEMENT_PATTERNS: Array<{ type: NodeType; rx: RegExp }> = [
  { type: 'import_statement', rx: /^\s*import\b|^\s*export\b[^=]*\bfrom\b/ },
  { type: 'export_statement', rx: /^\s*export\b/ },
  { type: 'interface_declaration', rx: /^\s*(export\s+)?interface\s+[A-Za-z_$]/ },
  { type: 'class_declaration', rx: /^\s*(export\s+)?(abstract\s+)?class\s+[A-Za-z_$]/ },
  { type: 'function_declaration', rx: /^\s*(export\s+)?(async\s+)?function\s*[A-Za-z_$*]/ },
  { type: 'variable_declaration', rx: /^\s*(export\s+)?(var|let|const)\s+[A-Za-z_$[{]/ },
  { type: 'arrow_function', rx: /=>/ },
  { type: 'call_expression', rx: /[A-Za-z_$][A-Za-z0-9_$.]*\s*\(/ },
];

export function parseSource(path: string, source: string): AstNode[] {
  if (typeof source !== 'string') {
    throw new EngineError('INPUT_ERROR', `source for ${path} must be a string`);
  }
  const { tokens, masked } = tokenize(source);
  const nodes: AstNode[] = [];
  for (const t of tokens) {
    nodes.push({
      type: t.kind === 'string' ? 'string_literal' : 'comment',
      line: t.line,
      column: t.column,
      text: t.text.length > 200 ? t.text.slice(0, 200) + '...' : t.text,
    });
  }
  const lines = masked.split('\n');
  const origLines = source.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const text = lines[idx];
    if (!text.trim()) continue;
    for (const { type, rx } of STATEMENT_PATTERNS) {
      if (rx.test(text)) {
        const col = text.length - text.trimStart().length + 1;
        nodes.push({ type, line: idx + 1, column: col, text: (origLines[idx] ?? text).trim().slice(0, 200) });
        // a line may carry several node kinds (e.g. const x = require(...))
      }
    }
  }
  nodes.sort((a, b) => a.line - b.line || a.column - b.column);
  return nodes;
}
