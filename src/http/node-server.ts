import { createServer, type Server } from 'node:http';
import type { HttpReply } from './core.ts';

type Handler = (method: string, path: string, body: unknown) => Promise<HttpReply>;

export function startNodeServer(handle: Handler, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body: unknown = undefined;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { category: 'INPUT_ERROR', message: 'request body is not valid JSON', details: null } }));
          return;
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const reply = await handle(req.method ?? 'GET', url.pathname, body);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
