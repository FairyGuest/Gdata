// 配置层：把外部 JSON 配置解析为内核消费的 RouteRule[]。
// 只做语法与语义校验，不做任何匹配/执行。所有非法输入抛 INPUT_ERROR。

import { readFileSync } from 'node:fs';
import type { HttpMethod, MockResponse, RouteRule } from '../contracts/types.js';
import { inputError } from '../contracts/errors.js';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const MAX_DELAY_MS = 30_000;

interface RawRoute {
  method?: unknown;
  path?: unknown;
  bodyMatch?: unknown;
  response?: unknown;
  responses?: unknown;
}

function assertResponse(raw: unknown, where: string): MockResponse {
  if (typeof raw !== 'object' || raw === null) throw inputError(`${where}: response 必须是对象`);
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'number' || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    throw inputError(`${where}: status 必须是 100-599 的整数`, r.status);
  }
  if (r.delayMs !== undefined) {
    if (typeof r.delayMs !== 'number' || r.delayMs < 0) throw inputError(`${where}: delayMs 必须是非负数`);
    if (r.delayMs > MAX_DELAY_MS) throw inputError(`${where}: delayMs 超过上限 ${MAX_DELAY_MS}`, r.delayMs);
  }
  if (r.headers !== undefined && (typeof r.headers !== 'object' || r.headers === null || Array.isArray(r.headers))) {
    throw inputError(`${where}: headers 必须是对象`);
  }
  return { status: r.status, headers: r.headers as Record<string, string> | undefined, body: r.body, delayMs: r.delayMs as number | undefined };
}

function assertBodyMatch(raw: unknown, where: string): NonNullable<RouteRule['bodyMatch']> {
  if (typeof raw !== 'object' || raw === null) throw inputError(`${where}: bodyMatch 必须是对象`);
  const bm = raw as Record<string, unknown>;
  if (bm.mode !== 'exact' && bm.mode !== 'contains') throw inputError(`${where}: bodyMatch.mode 必须是 exact|contains`);
  if (!('expected' in bm)) throw inputError(`${where}: bodyMatch.expected 缺失`);
  return { mode: bm.mode, expected: bm.expected };
}

/**
 * 校验并规范化原始路由配置。
 * 分组键 = method + path + bodyMatch：同一 (method,path,bodyMatch) 的多条声明
 * 按顺序合并为一个序号序列；bodyMatch 不同的同路径条目是独立规则。
 */
export function parseRouteConfig(raw: unknown): RouteRule[] {
  if (!Array.isArray(raw)) throw inputError('路由配置必须是数组');
  interface Group { method: HttpMethod; pattern: string; bodyMatch?: RouteRule['bodyMatch']; responses: MockResponse[] }
  const groups = new Map<string, Group>();
  raw.forEach((item, i) => {
    const where = `routes[${i}]`;
    if (typeof item !== 'object' || item === null) throw inputError(`${where}: 必须是对象`);
    const r = item as RawRoute;
    if (typeof r.method !== 'string' || !METHODS.includes(r.method.toUpperCase() as HttpMethod)) {
      throw inputError(`${where}: method 非法`, r.method);
    }
    const method = r.method.toUpperCase() as HttpMethod;
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) throw inputError(`${where}: path 必须以 / 开头`, r.path);
    const bm = r.bodyMatch === undefined ? undefined : assertBodyMatch(r.bodyMatch, where);
    const key = `${method} ${r.path} ${bm ? JSON.stringify(bm) : ''}`;
    let g = groups.get(key);
    if (!g) { g = { method, pattern: r.path, bodyMatch: bm, responses: [] }; groups.set(key, g); }
    if (r.responses !== undefined) {
      if (!Array.isArray(r.responses) || r.responses.length === 0) throw inputError(`${where}: responses 必须是非空数组`);
      r.responses.forEach((resp, j) => g!.responses.push(assertResponse(resp, `${where}.responses[${j}]`)));
    } else if (r.response !== undefined) {
      g.responses.push(assertResponse(r.response, `${where}.response`));
    } else {
      throw inputError(`${where}: 缺少 response 或 responses`);
    }
  });
  // 生成规则 id：同 method+pattern 多组时追加 #n 消歧。
  const seen = new Map<string, number>();
  return [...groups.values()].map((g) => {
    const base = `${g.method}:${g.pattern}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}#${n}`, method: g.method, pattern: g.pattern, bodyMatch: g.bodyMatch, responses: g.responses };
  });
}

/** 从 JSON 文件加载路由配置。 */
export function loadRouteConfigFile(path: string): RouteRule[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw inputError(`无法读取配置文件: ${path}`, String(e));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw inputError(`配置文件不是合法 JSON: ${path}`, String(e));
  }
  const root = json as Record<string, unknown>;
  return parseRouteConfig(Array.isArray(root) ? root : root.routes);
}
