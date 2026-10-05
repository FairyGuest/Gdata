// 诊断接口层：只读暴露状态 + 复位。
//
//   GET  /__mock/health    存活检查
//   GET  /__mock/requests  全部请求记录（按到达顺序）
//   GET  /__mock/stats     统计视图
//   POST /__mock/reset     清空记录与调用计数

import type { FastifyInstance } from 'fastify';
import type { MockStore } from '../state/store.js';

export function registerDiagnostics(app: FastifyInstance, store: MockStore): void {
  app.get('/__mock/health', async () => ({ ok: true, ts: new Date().toISOString() }));
  app.get('/__mock/requests', async () => ({ requests: store.listRequests() }));
  app.get('/__mock/stats', async () => store.stats());
  app.post('/__mock/reset', async () => {
    store.reset();
    return { ok: true, reset: true };
  });
}
