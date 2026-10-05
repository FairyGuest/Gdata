import fs from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import { ServiceConfig } from './contracts/types';
import { ChaosEngine } from './kernel/engine';
import { ChaosStore } from './state/store';
import { registerDiagnostics } from './diagnostics/routes';
import { proxyHandler } from './proxy';

export interface BuiltServer {
  app: FastifyInstance;
  engine: ChaosEngine;
  store: ChaosStore;
}

export interface BuildOptions {
  rng?: () => number;
}

export function buildServer(config: ServiceConfig, opts: BuildOptions = {}): BuiltServer {
  if (config.dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  const store = new ChaosStore(config.dbPath);
  const engine = new ChaosEngine(store, {
    maxActiveInjections: config.maxActiveInjections,
    rng: opts.rng,
  });
  const app = Fastify({ logger: false });
  const targetUrl = new URL(config.targetUrl);

  registerDiagnostics(app, { engine, store, maxDelayMs: config.maxDelayMs, startedAt: Date.now() });

  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

  app.all('/*', async (request, reply) => {
    if (request.url.startsWith('/chaos/')) {
      return reply.code(404).send({
        error: { category: 'input_error', message: 'unknown diagnostics route', details: { url: request.url } },
      });
    }
    return proxyHandler({ engine, store, targetUrl }, request, reply);
  });

  app.addHook('onClose', async () => {
    engine.shutdown();
    store.close();
  });

  return { app, engine, store };
}