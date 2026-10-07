// Service entry point. Prefers the Fastify adapter; falls back to the
// zero-dependency node:http adapter when fastify is not installed (offline).

import { loadConfig } from './config.ts';
import { LifecycleEngine } from './core/engine.ts';
import { SystemClock } from './core/clock.ts';
import { newRunId } from './core/idgen.ts';
import { EnvironmentStore } from './store/sqlite.ts';
import { startNodeServer } from './http/node-app.ts';
import type { ListeningApp } from './http/node-app.ts';

export async function startService(overrides: { dbFile?: string; port?: number } = {}) {
  const config = loadConfig();
  const store = new EnvironmentStore(overrides.dbFile ?? config.database.file);
  const clock = new SystemClock();
  const runId = newRunId();
  const engine = new LifecycleEngine({
    template: config.template,
    store,
    clock,
    runId,
    maxActivePerUser: config.quota.maxActivePerUser,
    maxRenewals: config.renew.maxRenewals,
  });

  let app: ListeningApp;
  let adapter = 'fastify';
  const fastifyAvailable = await import('fastify').then(() => true, () => false);
  if (fastifyAvailable) {
    const { startFastifyServer } = await import('./http/fastify-app.ts');
    app = await startFastifyServer(engine, store, runId, config.server.host, overrides.port ?? config.server.port);
  } else {
    adapter = 'node:http';
    console.warn('[server] fastify not installed; using built-in node:http adapter (run npm install to enable fastify)');
    app = await startNodeServer(engine, store, runId, config.server.host, overrides.port ?? config.server.port);
  }

  const sweeper = setInterval(() => engine.sweep(), config.server.sweepIntervalMs);
  sweeper.unref();

  console.log(`[server] runId=${runId} adapter=${adapter} listening on http://${config.server.host}:${app.port}`);
  return {
    runId,
    port: app.port,
    adapter,
    engine,
    store,
    async close() {
      clearInterval(sweeper);
      await app.close();
      store.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) {
  startService().catch((err) => {
    console.error('[server] fatal:', err);
    process.exit(1);
  });
}

