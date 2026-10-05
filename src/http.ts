// Diagnostics HTTP API. Route contract mirrors a Fastify-style interface
// (method + path + JSON in/out, {error:{category,message}} error envelope);
// implemented on node:http because Fastify cannot be installed offline here.
// Swap-in notes for Fastify are in the README.

import http from 'node:http';
import type { MutantQuery, RunRequest } from './contracts.ts';
import { toApiError, inputError } from './errors.ts';
import { MutationKernel } from './kernel.ts';
import { MutationStore } from './store.ts';
import { ALL_MUTATORS } from './mutators.ts';

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(inputError('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

const sendJson = (res: http.ServerResponse, statusCode: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
};

export const createServer = (kernel: MutationKernel, store: MutationStore): http.Server =>
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const segments = url.pathname.split('/').filter(Boolean);

      if (method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }

      if (method === 'POST' && url.pathname === '/runs') {
        const raw = await readBody(req);
        let body: RunRequest;
        try {
          body = JSON.parse(raw) as RunRequest;
        } catch {
          throw inputError('request body is not valid JSON');
        }
        if (typeof body !== 'object' || body === null) throw inputError('request body must be a JSON object');
        const runId = kernel.nextRunId();
        const report = await kernel.execute(body, runId);
        store.saveRun(report);
        return sendJson(res, report.status === 'completed' ? 201 : 200, report);
      }

      if (method === 'GET' && segments[0] === 'runs' && segments.length === 1) {
        return sendJson(res, 200, { runs: store.listRuns() });
      }

      if (method === 'GET' && segments[0] === 'runs' && segments.length === 2) {
        const report = store.getRun(segments[1]);
        if (!report) throw inputError('unknown run id: ' + segments[1], 404);
        return sendJson(res, 200, report);
      }

      if (method === 'GET' && url.pathname === '/mutants') {
        const query: MutantQuery = {};
        const file = url.searchParams.get('file');
        const mutator = url.searchParams.get('mutator');
        const runId = url.searchParams.get('runId');
        if (file) query.file = file;
        if (runId) query.runId = runId;
        if (mutator) {
          if (!ALL_MUTATORS.includes(mutator as (typeof ALL_MUTATORS)[number])) {
            throw inputError('unknown mutator filter: ' + mutator);
          }
          query.mutator = mutator as MutantQuery['mutator'];
        }
        return sendJson(res, 200, { mutants: store.queryMutants(query) });
      }

      throw inputError('no route for ' + method + ' ' + url.pathname, 404);
    } catch (err) {
      const { statusCode, body } = toApiError(err);
      sendJson(res, statusCode, body);
    }
  });
