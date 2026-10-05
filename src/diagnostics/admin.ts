import type { ServerResponse } from 'node:http';
import type { MockEngine } from '../core/engine.ts';
import type { RequestRecorder } from '../state/recorder.ts';
import { inputError } from '../contracts/errors.ts';

interface AdminContext {
  engine: MockEngine;
  recorder: RequestRecorder;
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  res: ServerResponse;
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void;
}

/**
 * 诊断/管理接口：
 *   GET  /__health           存活探针
 *   GET  /__routes           路由表与调用计数
 *   GET  /__requests         请求记录（?method=&path=&matched= 过滤）
 *   GET  /__requests/count   记录计数
 *   POST /__verify           断言 { method, path, times? } -> { ok, actual }
 *   POST /__reset            清空记录与调用计数
 */
export async function handleAdmin(ctx: AdminContext): Promise<void> {
  const { engine, recorder, method, path, query, body, res, sendJson } = ctx;

  if (method === 'GET' && path === '/__health') {
    sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }
  if (method === 'GET' && path === '/__routes') {
    sendJson(res, 200, { routes: engine.listRoutes() });
    return;
  }
  if (method === 'GET' && path === '/__requests') {
    const filter = {
      method: query.get('method') ?? undefined,
      path: query.get('path') ?? undefined,
      matched: query.has('matched') ? query.get('matched') === 'true' : undefined,
    };
    sendJson(res, 200, { requests: recorder.list(filter) });
    return;
  }
  if (method === 'GET' && path === '/__requests/count') {
    const filter = {
      method: query.get('method') ?? undefined,
      path: query.get('path') ?? undefined,
    };
    sendJson(res, 200, { count: recorder.count(filter) });
    return;
  }
  if (method === 'POST' && path === '/__verify') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw inputError('VERIFY_BODY_INVALID', '/__verify 需要 JSON 请求体 { method, path, times? }');
    }
    if (typeof parsed.method !== 'string' || typeof parsed.path !== 'string') {
      throw inputError('VERIFY_PARAMS_INVALID', '/__verify 缺少 method 或 path 字段');
    }
    const actual = recorder.count({ method: parsed.method, path: parsed.path });
    const expected = typeof parsed.times === 'number' ? parsed.times : undefined;
    const ok = expected === undefined ? actual > 0 : actual === expected;
    sendJson(res, 200, { ok, actual, expected: expected ?? '>=1' });
    return;
  }
  if (method === 'POST' && path === '/__reset') {
    recorder.reset();
    engine.reset();
    sendJson(res, 200, { reset: true });
    return;
  }
  throw inputError('ADMIN_UNKNOWN_ENDPOINT', `未知的管理接口: ${method} ${path}`);
}
