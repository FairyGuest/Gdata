import { parseSchema } from '../contract/schema.ts';
import { toErrorBody } from '../contract/errors.ts';
import { generateDataset } from '../kernel/generate.ts';
import type { DatasetStore } from '../state/store.ts';
import type { AppConfig } from '../config.ts';

export interface HttpReply {
  status: number;
  body: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createHandler(store: DatasetStore, config: AppConfig) {
  const limits = config.limits;

  return async function handle(method: string, path: string, body: unknown): Promise<HttpReply> {
    try {
      if (method === 'GET' && path === '/health') {
        return { status: 200, body: { status: 'ok', service: 'test-data-factory' } };
      }

      if (method === 'POST' && path === '/schemas/validate') {
        const schema = parseSchema(isObject(body) ? body.schema ?? body : body, limits);
        return { status: 200, body: { valid: true, schema } };
      }

      if (method === 'POST' && path === '/generate') {
        if (!isObject(body)) return err('INPUT_ERROR', 'body must be an object with schema/seed/count');
        const schema = parseSchema(body.schema, limits);
        const seed = (body.seed ?? 1) as number | string;
        const count = Number(body.count ?? 1);
        const result = generateDataset(schema, seed, count, limits);
        store.recordRun(result.log);
        return { status: 200, body: { runId: result.runId, seed, count, rows: result.rows } };
      }

      if (method === 'POST' && path === '/datasets') {
        if (!isObject(body) || typeof body.name !== 'string' || body.name.length === 0) {
          return err('INPUT_ERROR', 'body must include a non-empty "name"');
        }
        const schema = parseSchema(body.schema, limits);
        const seed = (body.seed ?? 1) as number | string;
        const count = Number(body.count ?? 1);
        const record = store.saveDataset(body.name, schema, seed, count, limits);
        return { status: 201, body: { name: record.name, seed: record.seed, count: record.count, createdAt: record.createdAt } };
      }

      if (method === 'GET' && path === '/datasets') {
        return { status: 200, body: { datasets: store.listDatasets() } };
      }

      const datasetMatch = path.match(/^\/datasets\/([^/]+)(\/verify)?$/);
      if (datasetMatch) {
        const name = decodeURIComponent(datasetMatch[1]);
        if (method === 'GET' && !datasetMatch[2]) {
          const record = store.getDataset(name);
          return { status: 200, body: record };
        }
        if (method === 'POST' && datasetMatch[2]) {
          return { status: 200, body: store.verifyDataset(name, limits) };
        }
      }

      const runMatch = path.match(/^\/runs\/([^/]+)$/);
      if (method === 'GET' && runMatch) {
        return { status: 200, body: store.getRun(decodeURIComponent(runMatch[1])) };
      }

      return err('INPUT_ERROR', 'no route for ' + method + ' ' + path);
    } catch (e) {
      const { status, body: errorBody } = toErrorBody(e);
      return { status, body: errorBody };
    }
  };
}

function err(category: string, message: string): HttpReply {
  const status = category === 'INPUT_ERROR' ? 400 : 500;
  return { status, body: { error: { category, message, details: null } } };
}
