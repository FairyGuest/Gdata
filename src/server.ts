import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AppError, toErrorBody } from './errors.ts';
import { parseRunRequest } from './contract.ts';
import { classify, type ClassifyOptions } from './classifier.ts';
import { executeSuite, type ExecutorOptions } from './executor.ts';
import type { Store } from './store.ts';

export interface ServerDeps {
  store: Store;
  limits: { maxRuns: number; maxTestsPerSuite: number };
  classifyOptions: ClassifyOptions;
  executorOptions: ExecutorOptions;
}

const MAX_BODY_BYTES = 1024 * 1024;

export function createApp(deps: ServerDeps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      const { status, body } = toErrorBody(err);
      sendJson(res, status, body);
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (method === 'POST' && path === '/v1/runs') {
    const raw = await readJsonBody(req);
    const request = parseRunRequest(raw, deps.limits);
    const { store } = deps;

    if (store.hasActiveRound(request.suiteId)) {
      throw new AppError('STATE_CONFLICT', 'suite already has a running round: ' + request.suiteId, {
        suiteId: request.suiteId,
      });
    }

    const roundId = store.createRound(request.suiteId, request.runs);
    try {
      const { outcomesByTest, log } = await executeSuite(request, deps.executorOptions);
      const classifications = request.tests.map((t) =>
        classify(t.name, outcomesByTest.get(t.name)!, deps.classifyOptions),
      );
      store.completeRound(roundId, log, classifications);
      sendJson(res, 200, {
        roundId,
        suiteId: request.suiteId,
        runs: request.runs,
        classifications,
        log,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.failRound(roundId, message);
      throw err;
    }
    return;
  }

  const reportMatch = path.match(/^\/v1\/reports\/(\d+)$/);
  if (method === 'GET' && reportMatch) {
    const roundId = Number(reportMatch[1]);
    const round = deps.store.getRound(roundId);
    if (!round) {
      throw new AppError('NOT_FOUND', 'no round with id ' + roundId, { roundId });
    }
    sendJson(res, 200, {
      round,
      classifications: deps.store.getClassifications(roundId),
      log: deps.store.getRunLog(roundId),
    });
    return;
  }

  const historyMatch = path.match(/^\/v1\/tests\/([^/]+)\/history$/);
  if (method === 'GET' && historyMatch) {
    const testName = decodeURIComponent(historyMatch[1]);
    const history = deps.store.getTestHistory(testName);
    if (history.length === 0) {
      throw new AppError('NOT_FOUND', 'no completed rounds recorded for test: ' + testName, { testName });
    }
    sendJson(res, 200, { testName, rounds: history });
    return;
  }

  throw new AppError('NOT_FOUND', 'unknown route: ' + method + ' ' + path);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError('RESOURCE_EXHAUSTED', 'request body exceeds 1 MiB limit', { maxBytes: MAX_BODY_BYTES }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('INPUT_ERROR', 'request body is not valid JSON'));
      }
    });
    req.on('error', () => reject(new AppError('INPUT_ERROR', 'failed to read request body')));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}
