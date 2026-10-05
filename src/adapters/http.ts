import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { MockResponse } from '../contracts/types.ts';
import { MockError, statusForCategory, computationFailure } from '../contracts/errors.ts';
import { MockEngine } from '../core/engine.ts';
import { RequestRecorder } from '../state/recorder.ts';
import { handleAdmin } from '../diagnostics/admin.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendMock(res: ServerResponse, response: MockResponse): void {
  const status = response.status ?? 200;
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  let payload: string;
  if (response.body === undefined) {
    payload = '';
  } else if (typeof response.body === 'string') {
    payload = response.body;
    headers['content-type'] ??= 'text/plain; charset=utf-8';
  } else {
    try {
      payload = JSON.stringify(response.body);
    } catch (cause) {
      throw computationFailure('BODY_SERIALIZE_FAILED', '响应体无法序列化为 JSON', String(cause));
    }
    headers['content-type'] ??= 'application/json; charset=utf-8';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

export interface MockServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * HTTP 适配层：把内核与记录器接到 node:http 上。
 * 所有 MockError 按类别映射状态码；未知异常一律 500 COMPUTATION_FAILURE，绝不吞错返回成功。
 */
export async function startMockServer(options: {
  engine: MockEngine;
  recorder: RequestRecorder;
  port?: number;
  host?: string;
}): Promise<MockServerHandle> {
  const { engine, recorder } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      const body = await readBody(req);

      // 诊断/管理接口（不进入请求记录）
      if (path.startsWith('/__')) {
        await handleAdmin({ engine, recorder, method, path, query: url.searchParams, body, res, sendJson });
        return;
      }

      // 业务请求：先记录，再执行内核
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      }

      let result;
      try {
        result = engine.execute({ method, path, body });
      } catch (err) {
        // 序号耗尽等状态冲突也要留痕
        recorder.record({
          method, path, query, headers, body,
          routeId: err instanceof MockError ? String((err.details as Record<string, unknown>)?.routeId ?? '') || null : null,
          matched: false,
          receivedAt: new Date().toISOString(),
        });
        throw err;
      }
      recorder.record({
        method, path, query, headers, body,
        routeId: result?.routeId ?? null,
        matched: result !== null,
        receivedAt: new Date().toISOString(),
      });

      if (result === null) {
        throw new MockError('NO_MATCH', 'MOCK_NO_ROUTE', `没有路由命中 ${method} ${path}`);
      }
      const delay = result.response.delayMs ?? 0;
      if (delay > 0) await sleep(delay);
      sendMock(res, result.response);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof MockError) {
        // 模拟执行期的状态冲突（序号耗尽）以 500 暴露，管理接口的冲突才是 409
        const status = err.code === 'SEQUENCE_EXHAUSTED' ? 500 : statusForCategory(err.category);
        sendJson(res, status, err.toPayload());
      } else {
        const wrapped = computationFailure('UNEXPECTED_FAILURE', '未预期的内部错误', String(err));
        sendJson(res, 500, wrapped.toPayload());
      }
    }
  });

  const port = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: actualPort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
