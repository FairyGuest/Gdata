// Proxy core: forwards to target, applies kernel decisions, records events.
// Faults never mutate the target; stopping injection restores normal pass-through.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { decideFaults, toEvent, type Decision } from './kernel.ts';
import type { FaultManager } from './state.ts';
import { ChaosError, log } from './contracts.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function forward(targetUrl: string, req: IncomingMessage): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url ?? '/', targetUrl);
    const up = httpRequest(u, { method: req.method, headers: { ...req.headers, host: u.host } }, (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => resolve({ status: upRes.statusCode ?? 502, headers: upRes.headers as Record<string, string | string[]>, body: Buffer.concat(chunks) }));
      upRes.on('error', reject);
    });
    up.on('error', (e) => reject(ChaosError.upstream(`target unreachable: ${e.message}`)));
    req.pipe(up);
  });
}

export function proxyHandler(targetUrl: string, fm: FaultManager, runId: string) {
  return async ({ req, res, requestId }: { req: IncomingMessage; res: ServerResponse; requestId: string }) => {
    const active = fm.list();
    const decisions: Decision[] = decideFaults(active, requestId);
    const record = (d: Decision, durationMs: number, detail?: string) => fm.record(toEvent(d, requestId, durationMs, detail));

    if (decisions.length > 0) {
      log(runId, 'info', 'proxy.inject', { requestId, faults: decisions.map((d) => d.faultType), reason: 'kernel decision fired' });
    }

    // 1. latency faults: sleep for the max requested delay, record each.
    const latencies = decisions.filter((d) => d.faultType === 'latency');
    for (const d of latencies) {
      const t0 = performance.now();
      await sleep(d.amount);
      record(d, Math.round(performance.now() - t0));
    }

    // 2. abort: destroy the client connection without responding.
    const abort = decisions.find((d) => d.faultType === 'abort');
    if (abort) {
      record(abort, 0);
      req.socket.destroy();
      return;
    }

    // 3. errorStatus: short-circuit with the configured status, target never sees the request.
    const errD = decisions.find((d) => d.faultType === 'errorStatus');
    if (errD) {
      record(errD, 0);
      res.writeHead(errD.amount, { 'content-type': 'application/json', 'x-chaos-injected': 'errorStatus', 'x-request-id': requestId });
      res.end(JSON.stringify({ error: { code: 'INJECTED_FAULT', message: `chaos injected status ${errD.amount}`, requestId } }));
      return;
    }

    // 4. forward to target.
    const up = await forward(targetUrl, req);

    // 5. truncate: cut the response body to keepRatio.
    const trunc = decisions.find((d) => d.faultType === 'truncate');
    let body = up.body;
    const headers: Record<string, string | string[]> = { ...up.headers, 'x-request-id': requestId };
    if (trunc) {
      const keep = Math.max(1, Math.floor(up.body.length * trunc.amount));
      body = up.body.subarray(0, keep);
      record(trunc, 0, `truncated ${up.body.length} -> ${body.length} bytes`);
      headers['x-chaos-injected'] = 'truncate';
    }
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers['content-length'] = String(body.length);
    res.writeHead(up.status, headers);
    res.end(body);
  };
}

export const newRequestId = () => randomUUID();
