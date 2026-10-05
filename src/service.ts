/**
 * Service layer: route-level operations shared by all HTTP adapters.
 * Returns plain {status, body} results; never throws past toErrorBody.
 */
import { toErrorBody, ValidationError } from "./errors.ts";
import { generateDataset } from "./generator.ts";
import { parseDatasetSchema } from "./schema.ts";
import { DatasetStore } from "./store.ts";
import { log, newRunId, recentLogs } from "./logger.ts";
import type { AppConfig } from "./config.ts";

export interface ServiceResult {
  status: number;
  body: unknown;
}

export interface Service {
  handle(method: string, path: string, body: unknown, query: URLSearchParams): Promise<ServiceResult>;
  close(): void;
}

function parseSeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError('"seed" is required and must be an integer', { seed: value ?? null });
  }
  return value;
}

function parseCount(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError('"count" must be a positive integer', { count: value });
  }
  return value;
}

export function createService(config: AppConfig, store: DatasetStore): Service {
  async function handle(method: string, path: string, body: unknown, query: URLSearchParams): Promise<ServiceResult> {
    const runId = newRunId();
    try {
      log(runId, "request", { method, path });
      const result = await route(runId, method, path, body, query);
      log(runId, "response", { status: result.status });
      return { ...result, body: withRunId(result.body, runId) };
    } catch (err) {
      const { status, body: errBody } = toErrorBody(err);
      log(runId, "error", { status, code: (errBody as { error: { code: string } }).error.code, message: (errBody as { error: { message: string } }).error.message });
      return { status, body: { ...errBody, runId } };
    }
  }

  async function route(runId: string, method: string, path: string, body: unknown, query: URLSearchParams): Promise<ServiceResult> {
    if (method === "GET" && path === "/health") {
      return { status: 200, body: { status: "ok" } };
    }

    if (method === "GET" && path === "/diagnostics/logs") {
      const limit = Number(query.get("limit") ?? "100");
      const runIdFilter = query.get("runId") ?? undefined;
      return { status: 200, body: { logs: recentLogs(Number.isInteger(limit) && limit > 0 ? limit : 100, runIdFilter) } };
    }

    if (method === "POST" && path === "/generate") {
      const req = (body ?? {}) as Record<string, unknown>;
      const seed = parseSeed(req.seed);
      const count = parseCount(req.count);
      const schema = parseDatasetSchema(req.schema);
      log(runId, "generate:start", { seed, count, fields: Object.keys(schema.fields) });
      const result = generateDataset(schema, { seed, count, limits: config.limits });
      log(runId, "generate:done", { seed, count, rows: result.rows.length });
      return { status: 200, body: result };
    }

    if (method === "POST" && path === "/datasets") {
      const req = (body ?? {}) as Record<string, unknown>;
      if (typeof req.id !== "string" || req.id.length === 0) {
        throw new ValidationError('"id" is required and must be a non-empty string');
      }
      const seed = parseSeed(req.seed);
      const count = parseCount(req.count);
      const schema = parseDatasetSchema(req.schema);
      const result = generateDataset(schema, { seed, count, limits: config.limits });
      const saved = store.save(req.id, seed, schema, result.rows);
      log(runId, "dataset:saved", { id: saved.id, seed, count: saved.count });
      return { status: 201, body: { id: saved.id, seed: saved.seed, count: saved.count, createdAt: saved.createdAt } };
    }

    if (method === "GET" && path === "/datasets") {
      return { status: 200, body: { datasets: store.list() } };
    }

    const datasetMatch = path.match(/^\/datasets\/([^/]+)(\/verify)?$/);
    if (datasetMatch) {
      const id = decodeURIComponent(datasetMatch[1]);
      if (method === "GET" && !datasetMatch[2]) {
        const stored = store.get(id);
        return { status: 200, body: stored };
      }
      if (method === "POST" && datasetMatch[2]) {
        const stored = store.get(id);
        log(runId, "verify:start", { id, seed: stored.seed, count: stored.count });
        const regenerated = generateDataset(stored.schema, { seed: stored.seed, count: stored.count, limits: config.limits });
        const match = JSON.stringify(regenerated.rows) === JSON.stringify(stored.rows);
        log(runId, "verify:done", { id, match, reason: match ? "regenerated rows identical to stored rows" : "regenerated rows differ from stored rows" });
        return { status: 200, body: { id, seed: stored.seed, count: stored.count, match } };
      }
    }

    return { status: 404, body: { error: { code: "NOT_FOUND", category: "state", message: `no route for ${method} ${path}`, details: null } } };
  }

  return {
    handle,
    close: () => store.close(),
  };
}

function withRunId(body: unknown, runId: string): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), runId };
  }
  return body;
}
