// 服务组装：路由 + 内核 + 存储 + 诊断。

import { createRouter } from "./http/router.ts";
import { ReportStore } from "./storage/reports.ts";
import { parseRunsPayload } from "./contracts/parse.ts";
import { aggregateRuns, filterAndSort } from "./core/aggregate.ts";
import { compareReports } from "./core/compare.ts";
import { createLogger, type Logger } from "./diagnostics/logger.ts";
import { inputError } from "./diagnostics/errors.ts";
import type { ServiceConfig } from "./config.ts";
import type { QueryFilter } from "./contracts/types.ts";
import { randomUUID } from "node:crypto";

export function buildApp(config: ServiceConfig, logger?: Logger) {
  const log = logger ?? createLogger();
  const store = new ReportStore(config.dbPath);
  const app = createRouter();

  app.route({
    method: "GET",
    url: "/health",
    handler: async (_req, reply) => {
      reply.status(200).send({ status: "ok" });
    },
  });

  // 诊断接口：错误语义目录
  app.route({
    method: "GET",
    url: "/api/diagnostics/errors",
    handler: async (_req, reply) => {
      reply.status(200).send({
        codes: {
          INPUT_ERROR: { http: 400, meaning: "请求体结构或字段类型非法" },
          UNKNOWN_STATUS: { http: 422, meaning: "无法识别的测试状态词" },
          STATUS_CONFLICT: { http: 409, meaning: "同一用例在多次运行中状态冲突" },
          RESOURCE_EXHAUSTED: { http: 413, meaning: "超出配置的资源上限" },
          NOT_FOUND: { http: 404, meaning: "报告或路由不存在" },
          COMPUTATION_FAILED: { http: 500, meaning: "聚合/对比计算失败" },
          STORAGE_FAILED: { http: 500, meaning: "SQLite 读写失败" },
        },
      });
    },
  });

  // 诊断接口：最近日志（可重放：含 runId/reportId/中间状态/判断理由）
  app.route({
    method: "GET",
    url: "/api/diagnostics/logs",
    handler: async (_req, reply) => {
      reply.status(200).send({ logs: log.entries() });
    },
  });

  app.route({
    method: "POST",
    url: "/api/reports",
    handler: async (req, reply) => {
      const runs = parseRunsPayload(req.body);
      const reportId = (req.body as any).reportId ?? randomUUID();
      for (const run of runs) {
        log.log({
          level: "info",
          event: "run_received",
          runId: run.runId,
          reportId,
          state: { caseCount: run.cases.length },
          reason: "accepted into aggregation pipeline",
        });
      }
      const report = aggregateRuns(runs, reportId, {
        maxCasesPerReport: config.maxCasesPerReport,
        maxRunsPerReport: config.maxRunsPerReport,
        logger: log,
      });
      store.save(report);
      reply.status(201).send(report);
    },
  });

  app.route({
    method: "GET",
    url: "/api/reports",
    handler: async (_req, reply) => {
      reply.status(200).send({ reports: store.list() });
    },
  });

  app.route({
    method: "GET",
    url: "/api/reports/:id",
    handler: async (req, reply) => {
      const report = store.get(req.params.id);
      const q = req.query;
      const filter: QueryFilter = {};
      if (q.file !== undefined) filter.file = q.file;
      if (q.name !== undefined) filter.name = q.name;
      if (q.status !== undefined) {
        if (!["passed", "failed", "skipped"].includes(q.status)) {
          throw inputError("status filter must be passed|failed|skipped", { got: q.status });
        }
        filter.status = q.status as QueryFilter["status"];
      }
      if (q.minDurationMs !== undefined) filter.minDurationMs = Number(q.minDurationMs);
      if (q.maxDurationMs !== undefined) filter.maxDurationMs = Number(q.maxDurationMs);
      if (q.sortBy !== undefined) {
        if (!["file", "name", "status", "durationMs"].includes(q.sortBy)) {
          throw inputError("sortBy must be file|name|status|durationMs", { got: q.sortBy });
        }
        filter.sortBy = q.sortBy as QueryFilter["sortBy"];
        filter.order = q.order === "desc" ? "desc" : "asc";
      }
      const cases = filterAndSort(report.cases, filter);
      reply.status(200).send({ ...report, cases });
    },
  });

  app.route({
    method: "GET",
    url: "/api/reports/:a/diff/:b",
    handler: async (req, reply) => {
      const base = store.get(req.params.a);
      const target = store.get(req.params.b);
      const diff = compareReports(base, target, log);
      reply.status(200).send(diff);
    },
  });

  return { app, store, logger: log };
}
