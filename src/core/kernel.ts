// 执行内核：路由匹配 -> 序号解析 -> 延迟 -> 产出响应。
// 依赖注入 MockStore，不感知 HTTP 层。执行期未预期异常包装为 EXECUTION_FAILURE。

import type { MockResponse, ResolvedResponse, RouteRule } from '../contracts/types.js';
import { executionFailure } from '../contracts/errors.js';
import { compilePattern, specificity } from './matcher.js';
import type { MockStore } from '../state/store.js';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object') {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function containsSubset(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) return deepEqual(actual, expected);
  if (typeof actual !== 'object' || actual === null) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => containsSubset(actual[i], e));
  }
  return Object.entries(expected as Record<string, unknown>).every(
    ([k, v]) => containsSubset((actual as Record<string, unknown>)[k], v)
  );
}

interface CompiledRule {
  rule: RouteRule;
  regex: RegExp;
  score: number;
}

export class MockKernel {
  private compiled: CompiledRule[];

  constructor(
    rules: RouteRule[],
    private store: MockStore,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.compiled = rules
      .map((rule) => ({ rule, regex: compilePattern(rule.pattern), score: specificity(rule.pattern) }))
      .sort((a, b) => b.score - a.score);
  }

  /** 查找匹配规则（方法+路径+可选请求体）。未命中返回 null。 */
  findRule(method: string, path: string, body: unknown): RouteRule | null {
    for (const c of this.compiled) {
      if (c.rule.method !== method) continue;
      if (!c.regex.test(path)) continue;
      const bm = c.rule.bodyMatch;
      if (bm) {
        const ok = bm.mode === 'exact' ? deepEqual(body, bm.expected) : containsSubset(body, bm.expected);
        if (!ok) continue;
      }
      return c.rule;
    }
    return null;
  }

  /** 解析本次调用应返回的响应：递增命中计数，按序号取响应，超出复用最后一个。 */
  resolve(rule: RouteRule): ResolvedResponse {
    try {
      const sequence = this.store.nextHit(rule.id);
      const response: MockResponse = rule.responses[Math.min(sequence, rule.responses.length) - 1];
      return { ruleId: rule.id, sequence, response };
    } catch (e) {
      if (e instanceof Error && 'category' in e) throw e;
      throw executionFailure(`规则 ${rule.id} 序号解析失败`, String(e));
    }
  }

  /** 应用延迟。 */
  async applyDelay(response: MockResponse): Promise<void> {
    if (response.delayMs && response.delayMs > 0) await this.sleep(response.delayMs);
  }
}
