import type { BodyMatch, MockResponse, RequestRecord, RouteConfig } from '../contracts/types.ts';
import { MockError, stateConflict } from '../contracts/errors.ts';
import { compilePattern, type CompiledPattern } from './pattern.ts';

/** 执行内核输入：一次已解析的 HTTP 请求。 */
export interface KernelRequest {
  method: string;
  path: string;
  body: string;
}

/** 执行内核输出：应返回的响应与命中信息。 */
export interface KernelResult {
  routeId: string | null;
  response: MockResponse;
  /** 该路由被调用的序号（从 1 开始）；未命中为 0。 */
  callIndex: number;
}

interface RouteEntry {
  config: RouteConfig;
  pattern: CompiledPattern;
  callCount: number;
}

function deepPartialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((e, i) => deepPartialMatch(e, (actual as unknown[])[i]));
  }
  return Object.entries(expected as Record<string, unknown>).every(
    ([k, v]) => deepPartialMatch(v, (actual as Record<string, unknown>)[k]),
  );
}

function bodyMatches(match: BodyMatch, rawBody: string): boolean {
  if (match.equals !== undefined && rawBody !== match.equals) return false;
  if (match.contains !== undefined && !rawBody.includes(match.contains)) return false;
  if (match.json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return false; // 非 JSON 体不满足 json 匹配
    }
    if (!deepPartialMatch(match.json, parsed)) return false;
  }
  return true;
}

/**
 * 执行内核：持有路由表与每条路由的调用计数，
 * 对每次请求做方法+路径+请求体匹配，按调用序号选择响应。
 * 不感知 HTTP 与存储，便于独立测试。
 */
export class MockEngine {
  private routes: RouteEntry[] = [];

  constructor(configs: RouteConfig[]) {
    for (const config of configs) this.addRoute(config);
  }

  addRoute(config: RouteConfig): void {
    const id = config.id ?? `${config.method} ${config.path}#${this.routes.length}`;
    if (this.routes.some((r) => r.config.id === id && config.id !== undefined)) {
      throw stateConflict('ROUTE_ID_DUPLICATE', `路由 id 重复: ${id}`);
    }
    this.routes.push({
      config: { ...config, id },
      pattern: compilePattern(config.path),
      callCount: 0,
    });
    // 特异性高的排前面，保证最具体的规则优先命中
    this.routes.sort((a, b) => b.pattern.specificity - a.pattern.specificity);
  }

  /** 匹配并推进调用计数。未命中返回 null（由适配层决定 404 语义）。 */
  execute(req: KernelRequest): KernelResult | null {
    const method = req.method.toUpperCase();
    for (const entry of this.routes) {
      const cfg = entry.config;
      if (cfg.method !== '*' && cfg.method !== method) continue;
      if (!entry.pattern.regex.test(req.path)) continue;
      if (cfg.bodyMatch && !bodyMatches(cfg.bodyMatch, req.body)) continue;

      entry.callCount++;
      const idx = entry.callCount - 1;
      const responses = cfg.responses;
      if (idx >= responses.length) {
        if ((cfg.onExhausted ?? 'error') === 'repeat-last') {
          return { routeId: cfg.id!, response: responses[responses.length - 1], callIndex: entry.callCount };
        }
        throw stateConflict(
          'SEQUENCE_EXHAUSTED',
          `路由 ${cfg.id} 的响应序列已耗尽（配置 ${responses.length} 个，第 ${entry.callCount} 次调用）`,
          { routeId: cfg.id, configured: responses.length, callIndex: entry.callCount },
        );
      }
      return { routeId: cfg.id!, response: responses[idx], callIndex: entry.callCount };
    }
    return null;
  }

  listRoutes(): Array<{ id: string; method: string; path: string; callCount: number; responses: number }> {
    return this.routes.map((r) => ({
      id: r.config.id!,
      method: r.config.method,
      path: r.config.path,
      callCount: r.callCount,
      responses: r.config.responses.length,
    }));
  }

  reset(): void {
    for (const r of this.routes) r.callCount = 0;
  }
}
