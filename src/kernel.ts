// Execution kernel: pure decision logic. Given active faults + rng, decide what hits this request.
// Pure & deterministic under an injected rng so tests can assert statistical distributions.
import type { ActiveFault, FaultEvent, FaultType } from './contracts.ts';

export interface Decision {
  faultType: FaultType;
  sessionId: string;
  /** latency: ms to sleep; truncate: bytes to keep (filled of body length); errorStatus: status code */
  amount: number;
  detail: string;
}

export type Rng = () => number;

/** Decide which faults fire for one request. Each active fault rolls independently. */
export function decideFaults(active: ActiveFault[], requestId: string, rng: Rng = Math.random): Decision[] {
  const out: Decision[] = [];
  for (const f of active) {
    if (rng() >= f.probability) continue;
    switch (f.type) {
      case 'latency':
        out.push({ faultType: 'latency', sessionId: f.sessionId, amount: f.params?.delayMs ?? 0, detail: `delay ${f.params?.delayMs ?? 0}ms` });
        break;
      case 'errorStatus':
        out.push({ faultType: 'errorStatus', sessionId: f.sessionId, amount: f.params?.statusCode ?? 500, detail: `respond ${f.params?.statusCode ?? 500}` });
        break;
      case 'abort':
        out.push({ faultType: 'abort', sessionId: f.sessionId, amount: 0, detail: 'destroy connection' });
        break;
      case 'truncate':
        out.push({ faultType: 'truncate', sessionId: f.sessionId, amount: f.params?.keepRatio ?? 0.3, detail: `keep ratio ${f.params?.keepRatio ?? 0.3}` });
        break;
    }
  }
  return out;
}

export function toEvent(d: Decision, requestId: string, durationMs: number, detail?: string): Omit<FaultEvent, 'id' | 'timestamp'> {
  return { sessionId: d.sessionId, requestId, faultType: d.faultType, durationMs, detail: detail ?? d.detail };
}

/** Deterministic rng for tests (mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
