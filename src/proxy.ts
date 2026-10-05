import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ChaosEngine } from './kernel/engine';
import { planFaults, sleep, truncateBody } from './kernel/faults';
import { ChaosStore } from './state/store';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

export interface ProxyContext {
  engine: ChaosEngine;
  store: ChaosStore;
  targetUrl: URL;
}

function bufferStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function readClientBody(request: FastifyRequest): Promise<Buffer> {
  if (request.body !== undefined && request.body !== null) {
    return Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
  }
  return bufferStream(request.raw);
}

/**
 * Forward one request to the target, applying planned faults.
 * Faults never mutate the target; once injections stop, traffic passes
 * through untouched.
 */
export async function proxyHandler(ctx: ProxyContext, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const requestId = randomUUID();
  ctx.store.insertRequest(requestId, Date.now(), request.method, request.url);

  const decisions = ctx.engine.decide(requestId);
  const plan = planFaults(decisions);

  if (plan.totalDelayMs > 0) {
    await sleep(plan.totalDelayMs);
  }

  if (plan.reset) {
    // Abruptly destroy the client socket; no HTTP response is sent.
    request.raw.socket.destroy();
    return;
  }

  const target = ctx.targetUrl;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (typeof v === 'string') headers[k] = v;
  }
  headers['x-chaos-request-id'] = requestId;

  const body = ['GET', 'HEAD'].includes(request.method) ? null : await readClientBody(request);

  const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: request.url,
        method: request.method,
        headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
      },
      resolve,
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  }).catch((err: Error) => {
    reply.code(502).send({
      error: {
        category: 'computation_failure',
        message: 'upstream request failed: ' + err.message,
        details: { requestId },
      },
    });
    return null;
  });
  if (!upstream) return;

  const upstreamBody = await bufferStream(upstream);
  const status = upstream.statusCode ?? 502;
  const respHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (typeof v === 'string') respHeaders[k] = v;
  }
  reply.headers(respHeaders);
  reply.header('x-chaos-request-id', requestId);

  if (plan.errorStatus !== null) {
    reply.header('content-type', 'application/json');
    reply.code(plan.errorStatus).send({
      error: {
        category: 'injected_fault',
        message: 'error status injected by chaos proxy',
        details: { requestId, originalStatus: status },
      },
    });
    return;
  }

  if (plan.keepRatio !== null) {
    const truncated = truncateBody(upstreamBody, plan.keepRatio);
    reply.header('content-length', String(truncated.length));
    reply.code(status).send(truncated);
    return;
  }

  reply.header('content-length', String(upstreamBody.length));
  reply.code(status).send(upstreamBody);
}