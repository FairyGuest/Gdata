import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isEngineError, httpStatusFor, EngineError } from '../contracts/errors.ts';
import { runCheck, validateRuleSet, validateRule } from '../core/engine.ts';
import type { Store } from '../state/store.ts';
import type { AppConfig } from '../config.ts';

type Handler = (ctx: {
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
}) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compilePath(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:[^/]+/g, (seg) => {
      keys.push(seg.slice(1));
      return '([^/]+)';
    }) + '$',
  );
  return { pattern, keys };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError('INPUT_ERROR', 'BODY_NOT_JSON', 'request body must be valid JSON');
  }
}

export function buildServer(store: Store, config: AppConfig): Server {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const { pattern, keys } = compilePath(path);
    routes.push({ method, pattern, keys, handler });
  };

  add('GET', '/health', () => ({ status: 'ok' }));

  add('GET', '/rules', () => ({ rules: store.listRules() }));

  add('PUT', '/rules', (ctx) => {
    const body = ctx.body as { rules?: unknown[] } | undefined;
    if (!body || !Array.isArray(body.rules)) {
      throw new EngineError('INPUT_ERROR', 'RULES_MISSING', 'body must be { rules: [...] }');
    }
    const rules = validateRuleSet(body.rules);
    store.replaceRules(rules);
    return { count: rules.length };
  });

  add('POST', '/rules', (ctx) => {
    const body = ctx.body as { rule?: unknown } | undefined;
    if (!body || body.rule === undefined) {
      throw new EngineError('INPUT_ERROR', 'RULE_MISSING', 'body must be { rule: {...} }');
    }
    const rule = validateRule(body.rule, 0);
    store.addRule(rule);
    return { added: rule.name };
  });

  add('PATCH', '/rules/:name', (ctx) => {
    const body = ctx.body as { enabled?: unknown } | undefined;
    if (!body || typeof body.enabled !== 'boolean') {
      throw new EngineError('INPUT_ERROR', 'ENABLED_MISSING', 'body must be { enabled: boolean }');
    }
    store.setRuleEnabled(ctx.params.name, body.enabled);
    return { name: ctx.params.name, enabled: body.enabled };
  });

  add('POST', '/check', (ctx) => {
    const body = ctx.body as { file?: unknown; source?: unknown } | undefined;
    if (!body || typeof body.file !== 'string' || typeof body.source !== 'string') {
      throw new EngineError('INPUT_ERROR', 'CHECK_ARGS_INVALID', 'body must be { file: string, source: string }');
    }
    const rules = store.listRules();
    const result = runCheck(body.file, body.source, rules, config.limits);
    store.saveRun(result.runId, result.file, result.violations, result.log);
    return result;
  });

  add('GET', '/runs/:id', (ctx) => store.getRun(ctx.params.id));

  add('GET', '/diff', (ctx) => {
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    if (!from || !to) {
      throw new EngineError('INPUT_ERROR', 'DIFF_ARGS_INVALID', 'query must include from and to run ids');
    }
    return store.diff(from, to);
  });

  return createServer(async (req, res) => {
    const reply = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        throw new EngineError('NOT_FOUND', 'ROUTE_NOT_FOUND', (req.method ?? '?') + ' ' + url.pathname + ' not found');
      }
      const m = route.pattern.exec(url.pathname) as RegExpExecArray;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : undefined;
      const result = await route.handler({ body, params, query: url.searchParams });
      reply(200, result);
    } catch (err) {
      if (isEngineError(err)) {
        reply(httpStatusFor(err.category), { error: { category: err.category, code: err.code, message: err.message } });
      } else {
        reply(500, { error: { category: 'COMPUTATION_ERROR', code: 'INTERNAL', message: String((err as Error)?.message ?? err) } });
      }
    }
  });
}

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
    });
  });
}

