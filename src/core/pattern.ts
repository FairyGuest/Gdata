import { computationFailure } from '../contracts/errors.ts';

/**
 * 通配符路径匹配。
 *  *  匹配单段内任意字符（不跨 /）
 *  ** 匹配任意字符（可跨 /）
 * 匹配结果带特异性评分，用于多条规则命中时选择最具体的一条。
 */
export interface CompiledPattern {
  raw: string;
  regex: RegExp;
  specificity: number; // 字面量字符越多越具体
}

export function compilePattern(pattern: string): CompiledPattern {
  if (!pattern.startsWith('/')) {
    throw computationFailure('PATTERN_NOT_ABSOLUTE', `路径模式必须以 / 开头: ${pattern}`);
  }
  let regex = '';
  let specificity = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { regex += '.*'; i++; }
      else { regex += '[^/]*'; }
    } else {
      regex += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      specificity++;
    }
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp('^' + regex + '$');
  } catch (cause) {
    throw computationFailure('PATTERN_COMPILE_FAILED', `路径模式编译失败: ${pattern}`, String(cause));
  }
  return { raw: pattern, regex: compiled, specificity };
}

export function matchPath(compiled: CompiledPattern, path: string): boolean {
  return compiled.regex.test(path);
}
