// Diagnostics HTTP API. Implemented on node:http behind a minimal router so
// the layer can be swapped for Fastify without touching the service core
// (offline environment: no external deps installable; see README).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { toErrorBody } from '../contract/errors.ts';
import type { MutationService } from '../service.ts';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw); // SyntaxError mapped to INPUT_INVALID by caller
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function createHttpServer(service: MutationService, logger: (m: string) => void): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    logger('[http] ' + method + ' ' + path);
    try {
      if (method === 'GET' && path === '/health') {
        return send(res, 200, { status: 'ok' });
      }
      if (method === 'POST' && path === '/runs') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch {
          return send(res, 400, { error: { code: 'INPUT_INVALID', message: 'Body is not valid JSON', details: null } });
        }
        const record = await service.run(body);
        return send(res, 201, record);
      }
      const runMatch = path.match(/^\/runs\/([0-9a-fA-F-]+)$/);
      if (method === 'GET' && runMatch) {
        return send(res, 200, service.getRun(runMatch[1]));
      }
      if (method === 'GET' && path === '/runs') {
        return send(res, 200, { runs: service.listRuns() });
      }
      if (method === 'GET' && path === '/mutants') {
        const results = service.queryMutants({
          file: url.searchParams.get('file') ?? undefined,
          type: url.searchParams.get('type') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
        });
        return send(res, 200, { count: results.length, results });
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route: ' + method + ' ' + path, details: null } });
    } catch (err) {
      const { status, body } = toErrorBody(err);
      return send(res, status, body);
    }
  });
}

