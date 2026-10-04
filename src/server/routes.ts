// 路由：诊断与扫描接口。错误按契约分类返回，绝不把失败吞成 200。
import type { App } from './fastify-lite.ts';
import type { Store } from '../state/store.ts';
import type { AppConfig } from '../config.ts';
import { runScan } from '../core/scanner.ts';
import { toErrorResponse } from '../contract/errors.ts';

export function registerRoutes(app: App, store: Store, config: AppConfig): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.get('/vulnerabilities', () => ({ vulnerabilities: store.listVulnerabilities() }));

  app.post('/scans', async (req, reply) => {
    try {
      const report = runScan(req.body, store, config);
      return reply.status(201).send(report);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return reply.status(status).send(body);
    }
  });

  app.get('/scans/:scanId', async (req, reply) => {
    const rec = store.getScan(req.params.scanId);
    if (!rec) {
      return reply.status(404).send({ error: { category: 'INPUT_ERROR', message: `scan "${req.params.scanId}" not found` } });
    }
    return rec;
  });

  app.get('/diagnostics/runs/:runId/logs', async (req, reply) => {
    const logs = store.getRunLogs(req.params.runId);
    if (logs.length === 0) {
      return reply.status(404).send({ error: { category: 'INPUT_ERROR', message: `run "${req.params.runId}" not found` } });
    }
    return { runId: req.params.runId, events: logs };
  });
}
