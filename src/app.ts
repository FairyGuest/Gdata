import Fastify from 'fastify';
import { DiagnosticReadModel } from './diag/readModel.js';
import { registerRoutes } from './http/routes.js';
import { TicketingKernel } from './kernel/ticketing.js';
import { TicketStore } from './state/store.js';

export function buildApp(filename = ':memory:', seed = true) {
  const store = new TicketStore(filename);
  if (seed) store.seedFixtures();
  const kernel = new TicketingKernel(store);
  const reads = new DiagnosticReadModel(store);
  const app = Fastify({ logger: false });
  registerRoutes(app, kernel, reads);
  return { app, store, kernel, reads };
}
