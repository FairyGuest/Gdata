// Zero-dependency transport adapter built on node:http. Used when the
// fastify package is not installed (offline environments).

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { buildRoutes, errorToResponse } from './routes.ts';
import type { HttpRequest, HttpResponse } from './routes.ts';
import type { LifecycleEngine } from '../core/engine.ts';
import type { EnvironmentStore } from '../store/sqlite.ts';

export interface ListeningApp {
  port: number;
  close(): Promise<void>;
}

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function startNodeServer(
  engine: LifecycleEngine,
  store: EnvironmentStore,
  runId: string,
  host: string,
  port: number,
): Promise<ListeningApp> {
  const routes = buildRoutes(engine, store, runId);

  const server: Server = createServer(async (req, res) => {
    const send = (response: HttpResponse) => {
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        return send({ status: 404, body: { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname} not found`, details: {} } } });
      }
      const match = url.pathname.match(route.pattern)!;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      const httpReq: HttpRequest = { params, query, body: await readBody(req) };
      send(route.handler(httpReq));
    } catch (err) {
      send(errorToResponse(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: boundPort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

