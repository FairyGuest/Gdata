// Service entry: wires config -> store -> state -> proxy + diagnostics.
import { randomUUID } from 'node:crypto';
import { loadConfig, type ServiceConfig } from './config.ts';
import { ChaosStore } from './store.ts';
import { FaultManager } from './state.ts';
import { Router, createHttpServer } from './http.ts';
import { proxyHandler, newRequestId } from './proxy.ts';
import { registerDiagnostics } from './diagnostics.ts';
import { log } from './contracts.ts';
import type { Server } from 'node:http';

export interface RunningService {
  server: Server;
  fm: FaultManager;
  runId: string;
  port: number;
  close: () => Promise<void>;
}

export async function startService(cfg?: Partial<ServiceConfig>): Promise<RunningService> {
  const base = loadConfig();
  const config: ServiceConfig = { ...base, ...cfg, initialFaults: cfg?.initialFaults ?? base.initialFaults };
  const runId = process.env.CHAOS_RUN_ID ?? randomUUID().slice(0, 8);
  process.env.CHAOS_RUN_ID = runId;

  const store = new ChaosStore(config.dbPath);
  const fm = new FaultManager(store, runId);

  const router = new Router();
  registerDiagnostics(router, fm, runId);
  router.setFallback(proxyHandler(config.targetUrl, fm, runId));

  const server = createHttpServer(router, newRequestId);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.proxyPort, () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  for (const [type, fc] of Object.entries(config.initialFaults)) {
    fm.start(type as never, fc);
  }
  log(runId, 'info', 'service.start', { port, targetUrl: config.targetUrl, dbPath: config.dbPath, reason: 'boot' });

  return {
    server, fm, runId, port,
    close: () => new Promise<void>((resolve) => { fm.shutdown(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href) {
  startService().catch((e) => { console.error(e); process.exit(1); });
}
