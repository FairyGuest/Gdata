import { httpRequest, startChaos, startInjection, stopChaos, TARGET_BODY } from '../test/helpers';

async function main(): Promise<void> {
  const ctx = await startChaos();
  console.log('[demo] chaos proxy at ' + ctx.base + ' -> target ' + ctx.target.url);

  const show = async (label: string, url: string) => {
    const r = await httpRequest(url);
    console.log('[demo] ' + label + ': status=' + r.status + ' elapsed=' + r.elapsedMs.toFixed(0) + 'ms bodyLen=' + r.body.length + (r.error ? ' error=' + r.error.message : ''));
  };

  await show('baseline            ', ctx.base + '/');

  const lat = await startInjection(ctx.base, { faultType: 'latency', probability: 1, params: { delayMs: 200 } });
  console.log('[demo] started latency injection ' + (lat.json.injection as { id: string }).id);
  await show('latency 200ms       ', ctx.base + '/');

  await startInjection(ctx.base, { faultType: 'error_status', probability: 0.5, params: { statusCode: 503 } });
  for (let i = 0; i < 4; i++) await show('latency+50% 503 #' + i, ctx.base + '/');

  await httpRequest(ctx.base + '/chaos/stop-all', { method: 'POST' });
  const trunc = await startInjection(ctx.base, { faultType: 'truncate', probability: 1, params: { keepRatio: 0.3 } });
  await show('truncate keep 30%   ', ctx.base + '/');
  await httpRequest(ctx.base + '/chaos/injections/' + (trunc.json.injection as { id: string }).id + '/stop', { method: 'POST' });

  const reset = await startInjection(ctx.base, { faultType: 'connection_reset', probability: 1 });
  await show('connection reset    ', ctx.base + '/');
  await httpRequest(ctx.base + '/chaos/injections/' + (reset.json.injection as { id: string }).id + '/stop', { method: 'POST' });

  await show('recovered           ', ctx.base + '/');
  const list = await httpRequest(ctx.base + '/chaos/injections');
  console.log('[demo] recorded sessions: ' + (JSON.parse(list.body).injections as unknown[]).length);
  console.log('[demo] target body intact: ' + (TARGET_BODY.length > 0));

  await stopChaos(ctx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});