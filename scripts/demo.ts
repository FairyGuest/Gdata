import { readFileSync } from 'node:fs';
import { OrchestratorStore } from '../src/store/db.ts';
import { buildApp } from '../src/http/app.ts';
import { loadConfig } from '../src/config.ts';
import type { OrchestrationDef } from '../src/domain/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/valid-stack.json', import.meta.url), 'utf8')) as OrchestrationDef;

const store = new OrchestratorStore('data/demo.db');
const built = await buildApp(store, loadConfig({}));
console.log('driver:', built.driver);

const created = await built.inject({ method: 'POST', url: '/orchestrations', payload: fixture });
if (created.statusCode === 201) {
  const body = created.json() as { plan: { layers: string[][]; startOrder: string[]; stopOrder: string[] } };
  console.log('created webshop v1');
  console.log('layers     :', JSON.stringify(body.plan.layers));
  console.log('start order:', body.plan.startOrder.join(' -> '));
  console.log('stop order :', body.plan.stopOrder.join(' -> '));
} else {
  console.log('webshop already exists (status ' + created.statusCode + '), showing stored plan');
}

const plan = await built.inject({ method: 'GET', url: '/orchestrations/webshop/plan' });
console.log('stored plan:', JSON.stringify((plan.json() as { plan: unknown }).plan));

const execRes = await built.inject({ method: 'POST', url: '/orchestrations/webshop/execute' });
const execBody = execRes.json() as { execution: { status: string; startedServices: string[] }; runId: string };
console.log('execution  :', execBody.execution.status, 'started:', execBody.execution.startedServices.join(', '));
console.log('run id     :', execBody.runId, '(query GET /diagnostics/runs/' + execBody.runId + ' for the replay log)');

await built.close();
store.close();
console.log('demo database written to data/demo.db');
