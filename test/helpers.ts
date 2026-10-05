import http from 'node:http';
import { AddressInfo } from 'node:net';
import { buildServer, BuiltServer } from '../src/server';
import { ServiceConfig } from '../src/contracts/types';

export const RUN_ID = 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);

export function logStep(test: string, step: string, state: Record<string, unknown>, reason: string): void {
  console.log('[chaos-test][' + RUN_ID + '][' + test + '] ' + step + ' | state=' + JSON.stringify(state) + ' | reason=' + reason);
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TargetServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  requestCount: () => number;
}

export const TARGET_BODY = 'hello-chaos-target-' + 'x'.repeat(200);

export function startTarget(): Promise<TargetServer> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    if (req.url === '/json') {
      const body = JSON.stringify({ ok: true, echo: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(TARGET_BODY);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: 'http://127.0.0.1:' + port,
        port,
        close: () => new Promise((r) => server.close(() => r())),
        requestCount: () => count,
      });
    });
  });
}

export interface ChaosContext {
  built: BuiltServer;
  base: string;
  target: TargetServer;
}

export async function startChaos(rng?: () => number): Promise<ChaosContext> {
  const target = await startTarget();
  const config: ServiceConfig = {
    port: 0,
    host: '127.0.0.1',
    targetUrl: target.url,
    dbPath: ':memory:',
    maxActiveInjections: 16,
    maxDelayMs: 60000,
  };
  const built = buildServer(config, { rng });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  return { built, base: 'http://127.0.0.1:' + addr.port, target };
}

export async function stopChaos(ctx: ChaosContext): Promise<void> {
  await ctx.built.app.close();
  await ctx.target.close();
}

export interface HttpResult {
  status: number;
  body: string;
  elapsedMs: number;
  headers: http.IncomingHttpHeaders;
  error?: Error;
}

export function httpRequest(
  url: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            elapsedMs: performance.now() - started,
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', (err) =>
      resolve({ status: 0, body: '', elapsedMs: performance.now() - started, headers: {}, error: err }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

export async function startInjection(
  base: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await httpRequest(base + '/chaos/injections', { method: 'POST', body });
  return { status: res.status, json: res.body ? JSON.parse(res.body) : {} };
}