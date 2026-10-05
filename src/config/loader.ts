import { readFileSync } from 'node:fs';
import type { RouteConfig } from '../contracts/types.ts';
import { inputError } from '../contracts/errors.ts';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*']);

/** 契约解析：校验并规范化路由配置。所有非法输入抛出 INPUT_ERROR。 */
export function parseRoutes(raw: unknown): RouteConfig[] {
  if (!Array.isArray(raw)) {
    throw inputError('CONFIG_NOT_ARRAY', '路由配置必须是数组');
  }
  const ids = new Set<string>();
  return raw.map((item, i) => {
    const where = `routes[${i}]`;
    if (item === null || typeof item !== 'object') {
      throw inputError('ROUTE_NOT_OBJECT', `${where} 必须是对象`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.method !== 'string' || !METHODS.has(r.method.toUpperCase())) {
      throw inputError('ROUTE_METHOD_INVALID', `${where}.method 非法: ${String(r.method)}`);
    }
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
      throw inputError('ROUTE_PATH_INVALID', `${where}.path 必须以 / 开头`);
    }
    if (!Array.isArray(r.responses) || r.responses.length === 0) {
      throw inputError('ROUTE_RESPONSES_EMPTY', `${where}.responses 必须是非空数组`);
    }
    for (const [j, resp] of r.responses.entries()) {
      if (resp === null || typeof resp !== 'object') {
        throw inputError('RESPONSE_NOT_OBJECT', `${where}.responses[${j}] 必须是对象`);
      }
      const rp = resp as Record<string, unknown>;
      if (rp.status !== undefined && (!Number.isInteger(rp.status) || (rp.status as number) < 100 || (rp.status as number) > 599)) {
        throw inputError('RESPONSE_STATUS_INVALID', `${where}.responses[${j}].status 必须是 100-599 的整数`);
      }
      if (rp.delayMs !== undefined && (typeof rp.delayMs !== 'number' || rp.delayMs < 0)) {
        throw inputError('RESPONSE_DELAY_INVALID', `${where}.responses[${j}].delayMs 必须是非负数`);
      }
    }
    if (r.id !== undefined) {
      if (typeof r.id !== 'string' || r.id.length === 0) {
        throw inputError('ROUTE_ID_INVALID', `${where}.id 必须是非空字符串`);
      }
      if (ids.has(r.id)) {
        throw inputError('ROUTE_ID_DUPLICATE', `路由 id 重复: ${r.id}`);
      }
      ids.add(r.id);
    }
    if (r.onExhausted !== undefined && r.onExhausted !== 'error' && r.onExhausted !== 'repeat-last') {
      throw inputError('ROUTE_ONEXHAUSTED_INVALID', `${where}.onExhausted 只能是 error 或 repeat-last`);
    }
    return { ...r, method: (r.method as string).toUpperCase() } as unknown as RouteConfig;
  });
}

export function loadRoutesFromFile(path: string): RouteConfig[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw inputError('CONFIG_FILE_UNREADABLE', `无法读取配置文件: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw inputError('CONFIG_JSON_INVALID', `配置文件不是合法 JSON: ${path}`, String(cause));
  }
  const routes = raw !== null && typeof raw === 'object' && 'routes' in raw
    ? (raw as Record<string, unknown>).routes
    : raw;
  return parseRoutes(routes);
}
