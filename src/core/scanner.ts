import type { AstNode, AstNodeType } from '../contracts/types.ts';

const FUNCTION_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const IMPORT_RE = /^\s*import\s/;
const STRING_RE = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;

export function scanSource(source: string): AstNode[] {
  const nodes: AstNode[] = [];
  const lines = source.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNo = i + 1;

    const fn = FUNCTION_RE.exec(lineText);
    if (fn) {
      nodes.push({
        type: 'FunctionDeclaration',
        line: lineNo,
        column: offset + lineText.indexOf(fn[1]) + 1,
        text: fn[1],
      });
    }

    if (IMPORT_RE.test(lineText)) {
      nodes.push({
        type: 'ImportStatement',
        line: lineNo,
        column: offset + (lineText.length - lineText.trimStart().length) + 1,
        text: lineText.trim(),
      });
    }

    STRING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_RE.exec(lineText)) !== null) {
      nodes.push({
        type: 'StringLiteral',
        line: lineNo,
        column: offset + m.index + 1,
        text: m[1],
      });
    }

    offset += lineText.length + 1;
  }
  return nodes;
}

export const SUPPORTED_NODE_TYPES: AstNodeType[] = [
  'FunctionDeclaration',
  'ImportStatement',
  'StringLiteral',
];

