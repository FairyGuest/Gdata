// 服务装配：Fastify 实例 + 兜底 mock 路由 + 诊断接口 + 统一错误映射。

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { RouteRule } from './contracts/types.js';
import { MockServerError, categoryToHttpStatus, executionFailure } from './contracts/errors.js';
import { MockKernel } from './core/kernel.js';
import { MockStore } from './state/store.js';
import { registerDiagnostics } from './diagnostics/routes.js';

export interface BuildOptions {
  rules: RouteRule[];
  dbPath?: string;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  store: MockStore;
  kernel: MockKernel;
}

const DIAG_PREFIX = '/__mock/';

export function buildServer(opts: BuildOptions): BuiltServer {
  const app = Fastify({ logger: opts.logger ?? false });
  const store = new MockStore(opts.dbPath ?? ':memory:');
  const kernel = new MockKernel(opts.rules, store);

  // 统一错误映射：分类错误 -> 对应状态码；未知错误 -> 500 EXECUTION_FAILURE，绝不吞成成功。
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof MockServerError) {
      reply.code(categoryToHttpStatus(err.category)).send({ error: { category: err.category, message: err.message, detail: err.detail ?? null } });
    } else {
      const wrapped = executionFailure(err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : undefined);
      reply.code(500).send({ error: { category: wrapped.category, message: wrapped.message } });
    }
  });

  registerDiagnostics(app, store);

  // 兜底：非诊断路径全部进入 mock 内核。
  app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url ?? '/';
    const path = url.split('?')[0] || '/';
    if (path.startsWith(DIAG_PREFIX)) {
      reply.code(404).send({ error: { category: 'INPUT_ERROR', message: `未知诊断接口: ${path}` } });
      return reply;
    }
    const method = req.method;
    const body = req.body;
    const rule = kernel.findRule(method, path, body);
    let respondedStatus: number | null = null;
    try {
      if (!rule) {
        respondedStatus = 404;
        reply.code(404).send({ error: { category: 'NO_MATCH', message: `无匹配路由: ${method} ${path}` } });
        return reply;
      }
      const resolved = kernel.resolve(rule);
      await kernel.applyDelay(resolved.response);
      respondedStatus = resolved.response.status;
      const { status, headers, body: respBody } = resolved.response;
      reply.code(status);
      for (const [k, v] of Object.entries(headers ?? {})) reply.header(k, v);
      reply.header('x-mock-rule', resolved.ruleId);
      reply.header('x-mock-sequence', String(resolved.sequence));
      if (respBody === undefined) return reply.send();
      if (typeof respBody === 'string') return reply.type('text/plain').send(respBody);
      return reply.send(respBody);
    } finally {
      store.record({
        method,
        path,
        query: (req.query ?? {}) as Record<string, unknown>,
        headers: req.headers as Record<string, unknown>,
        body,
        matchedRuleId: rule?.id ?? null,
        respondedStatus,
        receivedAt: new Date().toISOString(),
      });
    }
  });

  return { app, store, kernel };
}
