/**
 * One-shot acceptance run: exercises every lifecycle scenario in a fixed
 * order against a real server instance (injected via Fastify, time via
 * VirtualClock), printing each request, response and the judgment.
 * Exits 0 iff every scenario passes, 1 otherwise.
 */
import { VirtualClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { ErrorCode } from '../src/errors.ts';
import { buildServer } from '../src/server.ts';

const T0 = 1_700_000_000_000;

interface StepResult {
  name: string;
  passed: boolean;
  reason: string;
}

const results: StepResult[] = [];
let failures = 0;

function judge(name: string, passed: boolean, reason: string) {
  results.push({ name, passed, reason });
  if (!passed) failures++;
  console.log('  JUDGMENT: ' + (passed ? 'PASS' : 'FAIL') + ' - ' + reason);
}

function showRequest(method: string, url: string, body: unknown) {
  console.log('  REQUEST : ' + method + ' ' + url + (body === undefined ? '' : ' body=' + JSON.stringify(body)));
}

function showResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  console.log('  RESPONSE: ' + status + ' ' + (text.length > 220 ? text.slice(0, 220) + '...' : text));
}

async function main() {
  const clock = new VirtualClock(T0);
  const config = {
    ...loadConfig({} as NodeJS.ProcessEnv),
    dbPath: ':memory:',
    maxActiveTokensPerSubject: 2,
    defaultRefreshTtlSeconds: 120,
  };
  const { app, log } = buildServer({ config, clock });
  await app.ready();

  const call = async (method: 'POST' | 'GET', url: string, body?: unknown) => {
    showRequest(method, url, body);
    const res = await app.inject({ method, url, payload: body as object | undefined });
    const parsed = res.json();
    showResponse(res.statusCode, parsed);
    return { status: res.statusCode, body: parsed as Record<string, unknown> };
  };

  // --- S1: issue with explicit ttl and scopes ---------------------------
  console.log('\n[S1] issue token (subject=alice, ttl=60s, scopes=[read:docs,write:docs])');
  const s1 = await call('POST', '/tokens', {
    subject: 'alice',
    ttlSeconds: 60,
    scopes: ['read:docs', 'write:docs'],
  });
  const s1ok =
    s1.status === 200 &&
    s1.body.ok === true &&
    s1.body.expiresAtMs === T0 + 60_000 &&
    typeof s1.body.token === 'string';
  judge('S1 issue', s1ok, 'expected ok with expiresAtMs=' + (T0 + 60_000) + ', got ' + JSON.stringify({ status: s1.status, expiresAtMs: s1.body.expiresAtMs }));
  const token1 = s1.body.token as string;

  // --- S2: verify the fresh token ---------------------------------------
  console.log('\n[S2] verify fresh token');
  const s2 = await call('POST', '/tokens/verify', { token: token1 });
  const claims = s2.body.claims as { subject?: string; scopes?: string[] } | undefined;
  judge(
    'S2 verify',
    s2.status === 200 && claims?.subject === 'alice' &&
      JSON.stringify(claims?.scopes) === JSON.stringify(['read:docs', 'write:docs']),
    'expected claims subject=alice scopes=[read:docs,write:docs]',
  );

  // --- S3: concurrent double refresh, exactly one wins -------------------
  console.log('\n[S3] two concurrent refreshes of the same token');
  showRequest('POST', '/tokens/refresh x2 (concurrent)', { token: '<token1>' });
  const [r1, r2] = await Promise.all([
    app.inject({ method: 'POST', url: '/tokens/refresh', payload: { token: token1 } }),
    app.inject({ method: 'POST', url: '/tokens/refresh', payload: { token: token1 } }),
  ]);
  const pair = [r1, r2].map((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> }));
  for (const p of pair) showResponse(p.status, p.body);
  const winners = pair.filter((p) => p.status === 200);
  const losers = pair.filter((p) => p.status !== 200);
  const loserCodes = losers.map(
    (p) => (p.body.error as { code?: string } | undefined)?.code,
  );
  judge(
    'S3 concurrent refresh',
    winners.length === 1 &&
      losers.length === 1 &&
      loserCodes.every(
        (c) => c === ErrorCode.STATE_CONFLICT || c === ErrorCode.TOKEN_ROTATED,
      ),
    'expected exactly one 200 and one STATE_CONFLICT/TOKEN_ROTATED, got statuses ' +
      pair.map((p) => p.status).join(',') + ' codes ' + loserCodes.join(','),
  );
  const token2 = winners[0]?.body.token as string;

  // --- S4: the rotated old token is rejected with TOKEN_ROTATED ----------
  console.log('\n[S4] verify the rotated (replaced) token');
  const s4 = await call('POST', '/tokens/verify', { token: token1 });
  judge(
    'S4 rotated verify',
    s4.status === 401 && (s4.body.error as { code?: string })?.code === ErrorCode.TOKEN_ROTATED,
    'expected 401 TOKEN_ROTATED, got ' + s4.status + ' ' + JSON.stringify(s4.body.error),
  );

  // --- S5: reusing the rotated token for refresh fails -------------------
  console.log('\n[S5] refresh again with the rotated token');
  const s5 = await call('POST', '/tokens/refresh', { token: token1 });
  judge(
    'S5 rotated reuse',
    s5.status === 401 && (s5.body.error as { code?: string })?.code === ErrorCode.TOKEN_ROTATED,
    'expected 401 TOKEN_ROTATED, got ' + s5.status + ' ' + JSON.stringify(s5.body.error),
  );

  // --- S6: expiry boundary driven by the virtual clock -------------------
  console.log('\n[S6] expiry boundary (token2 ttl=120s, advance virtual clock)');
  clock.set(T0 + 120_000 - 1);
  const s6a = await call('POST', '/tokens/verify', { token: token2 });
  const s6aOk = s6a.status === 200;
  console.log('  (clock at exp-1ms: verify ' + (s6aOk ? 'accepted' : 'rejected') + ')');
  clock.set(T0 + 120_000);
  const s6b = await call('POST', '/tokens/verify', { token: token2 });
  const s6bOk =
    s6b.status === 401 && (s6b.body.error as { code?: string })?.code === ErrorCode.TOKEN_EXPIRED;
  judge(
    'S6 expiry boundary',
    s6aOk && s6bOk,
    'expected valid at exp-1ms and 401 TOKEN_EXPIRED at exp, got ' + s6a.status + ' then ' +
      s6b.status + ' ' + JSON.stringify(s6b.body.error),
  );

  // --- S7: revoke, then verify reports TOKEN_REVOKED ---------------------
  console.log('\n[S7] revoke a token, then verify it');
  const s7issue = await call('POST', '/tokens', {
    subject: 'bob',
    ttlSeconds: 600,
    scopes: ['read:docs'],
  });
  const token3 = s7issue.body.token as string;
  const s7rev = await call('POST', '/tokens/revoke', { token: token3 });
  const s7ver = await call('POST', '/tokens/verify', { token: token3 });
  judge(
    'S7 revoke then verify',
    s7rev.status === 200 &&
      s7ver.status === 401 &&
      (s7ver.body.error as { code?: string })?.code === ErrorCode.TOKEN_REVOKED,
    'expected revoke ok then 401 TOKEN_REVOKED, got ' + s7rev.status + ' then ' +
      s7ver.status + ' ' + JSON.stringify(s7ver.body.error),
  );

  // --- S8: contract violation is a VALIDATION_ERROR ----------------------
  console.log('\n[S8] issue with invalid payload (ttlSeconds=0, bad scope)');
  const s8 = await call('POST', '/tokens', {
    subject: 'alice',
    ttlSeconds: 0,
    scopes: ['BAD SCOPE'],
  });
  judge(
    'S8 validation',
    s8.status === 400 && (s8.body.error as { code?: string })?.code === ErrorCode.VALIDATION_ERROR,
    'expected 400 VALIDATION_ERROR, got ' + s8.status + ' ' + JSON.stringify(s8.body.error),
  );

  // --- S9: forged signature is TOKEN_INVALID_SIGNATURE -------------------
  console.log('\n[S9] verify a forged token (tampered signature)');
  const forged = token3.slice(0, -2) + (token3.endsWith('aa') ? 'bb' : 'aa');
  const s9 = await call('POST', '/tokens/verify', { token: forged });
  judge(
    'S9 forged token',
    s9.status === 401 &&
      (s9.body.error as { code?: string })?.code === ErrorCode.TOKEN_INVALID_SIGNATURE,
    'expected 401 TOKEN_INVALID_SIGNATURE, got ' + s9.status + ' ' + JSON.stringify(s9.body.error),
  );

  // --- S10: capacity guard reports RESOURCE_EXHAUSTED --------------------
  console.log('\n[S10] exceed max active tokens per subject (max=2)');
  await call('POST', '/tokens', { subject: 'carol', ttlSeconds: 600, scopes: ['read:docs'] });
  await call('POST', '/tokens', { subject: 'carol', ttlSeconds: 600, scopes: ['read:docs'] });
  const s10 = await call('POST', '/tokens', {
    subject: 'carol',
    ttlSeconds: 600,
    scopes: ['read:docs'],
  });
  judge(
    'S10 capacity',
    s10.status === 503 &&
      (s10.body.error as { code?: string })?.code === ErrorCode.RESOURCE_EXHAUSTED,
    'expected 503 RESOURCE_EXHAUSTED, got ' + s10.status + ' ' + JSON.stringify(s10.body.error),
  );

  // --- S11: diagnostics allow replaying the run --------------------------
  console.log('\n[S11] diagnostics expose run ids, outcomes and reasons');
  const events = log.list();
  const rotatedEvents = events.filter(
    (e) => e.outcome === 'failure' && e.reason === ErrorCode.TOKEN_ROTATED,
  );
  const sample = events.slice(-3).map((e) => ({
    seq: e.seq,
    runId: e.runId,
    op: e.op,
    outcome: e.outcome,
    reason: e.reason,
  }));
  console.log('  last events: ' + JSON.stringify(sample));
  judge(
    'S11 diagnostics',
    events.length > 0 &&
      events.every((e) => typeof e.runId === 'string' && e.runId.length > 0) &&
      rotatedEvents.length >= 1,
    'expected events with run ids and at least one TOKEN_ROTATED failure, got ' +
      events.length + ' events, ' + rotatedEvents.length + ' rotated failures',
  );

  await app.close();

  console.log('\n================ ACCEPTANCE SUMMARY ================');
  for (const r of results) {
    console.log((r.passed ? 'PASS' : 'FAIL') + '  ' + r.name);
  }
  console.log(results.filter((r) => r.passed).length + '/' + results.length + ' scenarios passed');
  if (failures > 0) {
    console.error('FAILED scenarios: ' + results.filter((r) => !r.passed).map((r) => r.name).join(', '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('acceptance run crashed:', err);
  process.exit(1);
});
