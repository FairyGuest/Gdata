import Fastify, { FastifyInstance } from 'fastify';
import {
  RunRequest,
  RunnerError,
  invalidInput,
  notFound,
  stateConflict,
} from './contracts';
import { RunnerConfig } from './config';
import { discoverTestFiles, topoSort } from './discovery';
import { executeAll } from './executor';
import { buildSummary } from './report';
import { RunStore } from './store';

/**
 * 诊断接口层：HTTP 契约。
 *   GET  /health                 存活探针
 *   POST /runs                   触发一次测试运行（同步返回完整汇总）
 *   GET  /runs/:runId            查询某次运行详情
 *   GET  /runs?file=&from=&to=   按文件名/时间范围查询历史
 * 错误统一为 { error: { code, message } }，HTTP 状态码与错误码一一对应。
 */
export function buildServer(cfg: RunnerConfig, store: RunStore): FastifyInstance {
  const app = Fastify({ logger: false });

  // 同一时刻只允许一个运行，避免对同一目录的并发运行互相干扰（状态冲突可区分）
  let running = false;

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as Error;
    if (err instanceof RunnerError) {
      reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
      return;
    }
    reply.status(500).send({ error: { code: 'INTERNAL', message: e.message } });
  });

  app.get('/health', async () => ({ status: 'ok', running }));

  app.post('/runs', async (req) => {
    const body = (req.body ?? {}) as Partial<RunRequest>;
    if (typeof body.dir !== 'string' || body.dir.length === 0) {
      throw invalidInput('请求体必须包含非空字符串字段 dir');
    }
    const pattern = body.pattern ?? cfg.defaultPattern;
    const timeoutMs = body.timeoutMs ?? cfg.defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw invalidInput('timeoutMs 必须为正整数');
    }
    if (timeoutMs > cfg.maxTimeoutMs) {
      throw invalidInput('timeoutMs 超过服务上限 ' + cfg.maxTimeoutMs);
    }
    const parallel = body.parallel ?? true;
    const concurrency = body.concurrency ?? Math.min(4, cfg.maxConcurrency);

    if (running) {
      throw stateConflict('已有测试运行正在进行中，请等待其完成后再发起');
    }
    running = true;
    const logs: string[] = [];
    const log = (msg: string) => logs.push(new Date().toISOString() + ' ' + msg);
    try {
      const files = discoverTestFiles({ dir: body.dir, pattern, maxFiles: cfg.maxFiles });
      log('在 ' + body.dir + ' 按模式 ' + pattern + ' 发现 ' + files.length + ' 个测试文件');
      const ordered = topoSort(files, cfg.dependencies);
      if (ordered.join() !== files.join()) {
        log('按依赖关系调整执行顺序: ' + ordered.join(' -> '));
      }
      const startedAt = new Date();
      const results = await executeAll({
        dir: body.dir,
        files,
        orderedFiles: ordered,
        dependencies: cfg.dependencies,
        parallel,
        concurrency,
        timeoutMs,
        maxConcurrency: cfg.maxConcurrency,
        onLog: log,
      });
      const summary = buildSummary(startedAt, results, logs);
      summary.logs.push(new Date().toISOString() + ' 运行完成: ' + summary.status + ' runId=' + summary.runId);
      store.saveRun(summary);
      return summary;
    } finally {
      running = false;
    }
  });

  app.get('/runs/:runId', async (req) => {
    const { runId } = req.params as { runId: string };
    const run = store.getRun(runId);
    if (!run) throw notFound('运行不存在: ' + runId);
    return run;
  });

  app.get('/runs', async (req) => {
    const q = req.query as { file?: string; from?: string; to?: string; limit?: string };
    return {
      runs: store.queryRuns({
        file: q.file,
        from: q.from,
        to: q.to,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  return app;
}