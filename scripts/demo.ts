// Local demo: drives the engine directly with a VirtualClock so TTL expiry
// can be observed without waiting in real time.

import { LifecycleEngine } from '../src/core/engine.ts';
import { VirtualClock } from '../src/core/clock.ts';
import { EnvironmentStore } from '../src/store/sqlite.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const store = new EnvironmentStore(':memory:');
const clock = new VirtualClock();
const engine = new LifecycleEngine({
  template: config.template, store, clock, runId: 'demo-run',
  maxActivePerUser: config.quota.maxActivePerUser, maxRenewals: config.renew.maxRenewals,
});

const log = (msg: string, v?: unknown) => console.log(msg, v === undefined ? '' : JSON.stringify(v));

log('template:', config.template.name);
const a = engine.create({ owner: 'alice', branch: 'feat/demo', overrides: { 'web.replicas': 2 }, ttlSeconds: 60 });
log('created:', { id: a.env.id, status: a.env.status, expiresIn: '60s' });
engine.markActive(a.env.id);
log('deploy complete -> ACTIVE');
engine.renew(a.env.id);
log('renewed once, renewalsUsed =', engine.get(a.env.id).renewalsUsed);

clock.advanceSeconds(121);
log('virtual clock advanced 121s');
log('swept:', engine.sweep());
log('status now:', engine.get(a.env.id).status);
log('transitions:', store.transitions(a.env.id).map((t) => `${t.from}->${t.to} (${t.reason})`));
store.close();

