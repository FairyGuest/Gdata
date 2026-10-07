import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { parseSpec } from '../contract/parse.ts';
import { OrchestrationError } from '../contract/errors.ts';
import { validateSpec } from '../core/validate.ts';
import { layeredTopoSort } from '../core/topo.ts';
import { affectedClosure } from '../core/impact.ts';
import { simulateStartup } from '../core/health.ts';
import type { Store } from '../state/store.ts';

export interface RoutesOptions {
  store: Store;
}

function makeLogger(runId: string, sink: string[]) {
  return (line: string) => {
    const entry = `[run ${runId}] ${line}`;
    sink.push(entry);
    console.log(entry);
  };
}

export function registerRoutes(app: FastifyInstance, opts: RoutesOptions): void {
  const { store } = opts;

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/orchestrations', async (req, reply) => {
    const runId = randomUUID();
    const logLines: string[] = [];
    const log = makeLogger(runId, logLines);
    log('stage=parse: parsing orchestration spec');
    const spec = parseSpec(req.body);
    log(`stage=validate: validating ${spec.services.length} services`);
    validateSpec(spec);
    log('stage=plan: validation passed, computing layered topological order');
    const plan = layeredTopoSort(spec);
    log(`stage=plan: layers=${JSON.stringify(plan.layers)} start=${plan.startOrder.join(',')} stop=${plan.stopOrder.join(',')}`);
    const version = store.saveOrchestration(spec.name, JSON.stringify(spec));
    store.saveResult({
      orchestrationVersion: version,
      runId,
      kind: 'plan',
      status: 'ok',
      input: spec,
      result: plan,
      log: logLines,
    });
    return reply.status(201).send({ version, runId, ...plan });
  });

  app.get('/orchestrations/:version/plan', async (req) => {
    const version = Number((req.params as { version: string }).version);
    const stored = store.getLatestResult(version, 'plan');
    return { version, runId: stored.runId, createdAt: stored.createdAt, ...JSON.parse(stored.resultJson) };
  });

  app.post('/orchestrations/:version/startup', async (req) => {
    const version = Number((req.params as { version: string }).version);
    const orch = store.getOrchestration(version);
    const spec = parseSpec(JSON.parse(orch.specJson));
    const runId = randomUUID();
    const logLines: string[] = [];
    const log = makeLogger(runId, logLines);
    log(`stage=startup: version=${version} spec="${spec.name}"`);
    const plan = layeredTopoSort(spec);
    const result = simulateStartup(spec, plan.layers, log);
    log(`stage=startup: status=${result.status}`);
    store.saveResult({
      orchestrationVersion: version,
      runId,
      kind: 'startup',
      status: result.status,
      input: { version },
      result,
      log: logLines,
    });
    return { version, runId, ...result };
  });

  app.post('/orchestrations/:version/impact', async (req) => {
    const version = Number((req.params as { version: string }).version);
    const body = req.body as { changedService?: unknown };
    if (!body || typeof body.changedService !== 'string') {
      throw new OrchestrationError('CONTRACT_PARSE_ERROR', 'body must be { "changedService": "<name>" }');
    }
    const orch = store.getOrchestration(version);
    const spec = parseSpec(JSON.parse(orch.specJson));
    const runId = randomUUID();
    const logLines: string[] = [];
    const log = makeLogger(runId, logLines);
    log(`stage=impact: version=${version} changedService=${body.changedService}`);
    const impact = affectedClosure(spec, body.changedService);
    log(`stage=impact: affected=[${impact.affected.join(',')}] skipped=[${impact.skipped.join(',')}] (transitive dependents of ${body.changedService})`);
    store.saveResult({
      orchestrationVersion: version,
      runId,
      kind: 'impact',
      status: 'ok',
      input: { version, changedService: body.changedService },
      result: impact,
      log: logLines,
    });
    return { version, runId, ...impact };
  });

  app.get('/runs/:runId', async (req) => {
    const { runId } = req.params as { runId: string };
    const stored = store.getRun(runId);
    return {
      runId: stored.runId,
      orchestrationVersion: stored.orchestrationVersion,
      kind: stored.kind,
      status: stored.status,
      createdAt: stored.createdAt,
      input: JSON.parse(stored.inputJson),
      result: JSON.parse(stored.resultJson),
      log: JSON.parse(stored.logJson),
    };
  });
}
