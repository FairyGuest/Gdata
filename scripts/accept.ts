// One-shot acceptance drill. Fixed scenario order; prints request/response/verdict per step.
// Exit 0 iff every scenario passes; non-zero names the failed scenario.
import { startService } from '../src/server.ts';
import { startTarget } from '../src/target.ts';

let failures = 0;
let current = '';
const step = (name: string) => { current = name; console.log(`
=== ${name} ===`); };
const ok = (cond: boolean, verdict: string) => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${verdict}`);
  if (!cond) { failures++; throw new Error(`scenario failed: ${current} -- ${verdict}`); }
};
const show = (label: string, v: unknown) => console.log(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const target = await startTarget(0);
const svc = await startService({ proxyPort: 0, targetUrl: `http://127.0.0.1:${target.port}`, dbPath: ':memory:', initialFaults: {} });
const base = `http://127.0.0.1:${svc.port}`;
console.log(`runId=${svc.runId} proxy=:${svc.port} target=:${target.port}`);

const api = async (path: string, method = 'GET', body?: unknown) => {
  show(`-> ${method}`, path + (body ? ' ' + JSON.stringify(body) : ''));
  const res = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  show('<- ' + res.status, json);
  return { status: res.status, json };
};

try {
  step('1. baseline pass-through (no faults)');
  {
    const res = await fetch(base + '/api/hello');
    const j = await res.json();
    show('<- 200', { message: j.message, paddingLen: j.padding.length });
    ok(res.status === 200 && j.padding?.length === 1000, 'target responds unmodified');
  }

  step('2. latency injection timing');
  {
    const { json } = await api('/chaos/faults/latency/start', 'POST', { probability: 1, params: { delayMs: 300 } });
    const sid = json.started.sessionId;
    const t0 = performance.now();
    const res = await fetch(base + '/api/hello');
    const elapsed = Math.round(performance.now() - t0);
    show('measured', `${elapsed}ms (injected 300ms, status ${res.status})`);
    ok(res.status === 200 && elapsed >= 290, `delay injected: ${elapsed}ms >= ~300ms`);
    const stats = await api(`/chaos/sessions/${sid}`);
    ok(stats.json.affectedRequests === 1 && stats.json.events[0].durationMs >= 290,
      `history: 1 affected request, recorded duration ${stats.json.events[0].durationMs}ms`);
    await api('/chaos/faults/latency/stop', 'POST');
    const t1 = performance.now();
    await fetch(base + '/api/hello');
    const e2 = Math.round(performance.now() - t1);
    ok(e2 < 200, `recovered after stop: ${e2}ms`);
  }

  step('3. probabilistic injection distribution (p=0.5, N=200)');
  {
    const { json } = await api('/chaos/faults/errorStatus/start', 'POST', { probability: 0.5, params: { statusCode: 500 } });
    const sid = json.started.sessionId;
    let injected = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(base + '/api/hello');
      if (res.status === 500) injected++; else await res.text();
    }
    const rate = injected / 200;
    show('observed', `${injected}/200 = ${rate}`);
    ok(rate > 0.35 && rate < 0.65, `rate ${rate} within [0.35, 0.65] of p=0.5`);
    await api('/chaos/faults/errorStatus/stop', 'POST');
    const stats = await api(`/chaos/sessions/${sid}`);
    ok(stats.json.affectedRequests === injected, `sqlite count ${stats.json.affectedRequests} == observed ${injected}`);
  }

  step('4. errorStatus fault');
  {
    await api('/chaos/faults/errorStatus/start', 'POST', { probability: 1, params: { statusCode: 503 } });
    const res = await fetch(base + '/api/hello');
    const j = await res.json();
    show('<- ' + res.status, j);
    ok(res.status === 503 && j.error.code === 'INJECTED_FAULT', 'short-circuited with 503');
    await api('/chaos/faults/errorStatus/stop', 'POST');
    ok((await fetch(base + '/api/hello')).status === 200, 'recovered after stop');
  }

  step('5. truncate fault');
  {
    const full = (await (await fetch(`http://127.0.0.1:${target.port}/api/hello`)).text()).length;
    await api('/chaos/faults/truncate/start', 'POST', { probability: 1, params: { keepRatio: 0.2 } });
    const cut = (await (await fetch(base + '/api/hello')).text()).length;
    show('lengths', `full=${full} truncated=${cut}`);
    ok(cut < full * 0.25, `body truncated to ${cut} bytes`);
    await api('/chaos/faults/truncate/stop', 'POST');
    const again = (await (await fetch(base + '/api/hello')).text()).length;
    ok(again === full, `recovered: full body ${again} bytes`);
  }

  step('6. abort fault (connection destroyed)');
  {
    await api('/chaos/faults/abort/start', 'POST', { probability: 1 });
    let threw = false;
    try { await fetch(base + '/api/hello'); } catch { threw = true; }
    ok(threw, 'client connection destroyed');
    await api('/chaos/faults/abort/stop', 'POST');
    ok((await fetch(base + '/api/hello')).status === 200, 'recovered after stop');
  }

  step('7. multiple faults simultaneously, independent control');
  {
    await api('/chaos/faults/latency/start', 'POST', { probability: 1, params: { delayMs: 150 } });
    await api('/chaos/faults/errorStatus/start', 'POST', { probability: 1, params: { statusCode: 502 } });
    const st = await api('/chaos/status');
    ok(st.json.active.length === 2, 'two faults active');
    const t0 = performance.now();
    const res = await fetch(base + '/api/hello');
    const el = Math.round(performance.now() - t0);
    ok(res.status === 502 && el >= 140, `both applied: status 502 after ${el}ms`);
    await api('/chaos/faults/errorStatus/stop', 'POST');
    const t1 = performance.now();
    const res2 = await fetch(base + '/api/hello');
    const el2 = Math.round(performance.now() - t1);
    ok(res2.status === 200 && el2 >= 140, `latency still active alone: ${el2}ms, status 200`);
    await api('/chaos/stop-all', 'POST');
    const t2 = performance.now();
    const res3 = await fetch(base + '/api/hello');
    const el3 = Math.round(performance.now() - t2);
    ok(res3.status === 200 && el3 < 100, `fully recovered after stop-all: ${el3}ms`);
  }

  step('8. auto-stop after durationMs');
  {
    const { json } = await api('/chaos/faults/latency/start', 'POST', { probability: 1, durationMs: 300, params: { delayMs: 50 } });
    show('stopsAt', json.started.stopsAt);
    await new Promise((r) => setTimeout(r, 500));
    const st = await api('/chaos/status');
    ok(st.json.active.length === 0, 'fault auto-stopped after 300ms');
  }

  step('9. error semantics are distinguishable');
  {
    const bad = await api('/chaos/faults/latency/start', 'POST', { probability: 2 });
    ok(bad.status === 400 && bad.json.error.code === 'INVALID_CONFIG', 'invalid input -> 400 INVALID_CONFIG');
    const conflict = await api('/chaos/faults/latency/stop', 'POST');
    ok(conflict.status === 409 && conflict.json.error.code === 'FAULT_NOT_ACTIVE', 'state conflict -> 409 FAULT_NOT_ACTIVE');
    const ghost = await api('/chaos/sessions/nope');
    ok(ghost.status === 404 && ghost.json.error.code === 'NOT_FOUND', 'unknown session -> 404 NOT_FOUND');
  }
} catch (e) {
  console.error(`
ACCEPTANCE FAILED: ${(e as Error).message}`);
} finally {
  await svc.close();
  target.server.closeAllConnections();
  target.server.close();
}

if (failures > 0) { console.error(`
${failures} scenario check(s) failed`); process.exit(1); }
console.log('ALL ACCEPTANCE SCENARIOS PASSED');
process.exit(0);
