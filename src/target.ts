// Demo target service: a normal HTTP service to be chaos-injected.
import { createServer } from 'node:http';

export function startTarget(port = Number(process.env.TARGET_PORT ?? 8500)) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/hello') {
      const body = JSON.stringify({ message: 'hello from target', padding: 'x'.repeat(1000), ts: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/slow') {
      setTimeout(() => { res.writeHead(200); res.end('{"slow":true}'); }, 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: url.pathname, ok: true }));
  });
  return new Promise<{ server: typeof server; port: number }>((resolve) => {
    server.listen(port, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href) {
  startTarget().then(({ port }) => console.log(`target listening on ${port}`));
}
