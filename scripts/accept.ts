import assert from 'node:assert/strict';
import { httpRequest, startChaos, startInjection, stopChaos, TARGET_BODY } from '../test/helpers';

/** End-to-end acceptance pass over the public HTTP API. */
async function main(): Promise<void> {
  const ctx = await startChaos();
  const check = (label: string, fn: () => void) => {
    fn();
    console.log('[accept] ok: ' + label);
  };

  try {
    const baseline = await httpRequest(ctx.base + '/');
    check('baseline passthrough', () => {
      assert.equal(baseline.status, 200);
      assert.equal(baseline.body, TARGET_BODY);
    });

    const bad = await startInjection(ctx.base, { faultType: 'latency', probability: 2 });
    check('invalid input -> 400 input_error', () => {
      assert.equal(bad.status, 400);
      assert.equal((bad.json.error as { category: string }).category, 'input_error');
    });

    const lat = await startInjection(ctx.base, { faultType: 'latency', probability: 1, params: { delayMs: 100 } });
    const latId = (lat.json.injection as { id: string }).id;
    const delayed = await httpRequest(ctx.base + '/');
    check('latency fault applied', () => {
      assert.equal(lat.status, 201);
      assert.ok(delayed.elapsedMs >= 90, 'elapsed ' + delayed.elapsedMs);
    });

    const err = await startInjection(ctx.base, { faultType: 'error_status', probability: 1, params: { statusCode: 503 } });
    const errId = (err.json.injection as { id: string }).id;
    const failed = await httpRequest(ctx.base + '/');
    check('error_status fault applied', () => assert.equal(failed.status, 503));

    const stats = JSON.parse((await httpRequest(ctx.base + '/chaos/injections/' + errId + '/stats')).body);
    check('stats recorded', () => assert.ok(stats.stats.affectedRequests >= 1));

    await httpRequest(ctx.base + '/chaos/injections/' + latId + '/stop', { method: 'POST' });
    await httpRequest(ctx.base + '/chaos/injections/' + errId + '/stop', { method: 'POST' });
    const recovered = await httpRequest(ctx.base + '/');
    check('full recovery after stop', () => {
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body, TARGET_BODY);
      assert.ok(recovered.elapsedMs < 100, 'elapsed ' + recovered.elapsedMs);
    });

    console.log('[accept] all checks passed');
  } finally {
    await stopChaos(ctx);
  }
}

main().catch((e) => {
  console.error('[accept] FAILED:', e);
  process.exit(1);
});
