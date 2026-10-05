import { FaultDecision } from '../contracts/types';

export interface AppliedFaults {
  totalDelayMs: number;
  reset: boolean;
  errorStatus: number | null;
  keepRatio: number | null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Combine per-request decisions into one executable plan. */
export function planFaults(decisions: FaultDecision[]): AppliedFaults {
  const plan: AppliedFaults = { totalDelayMs: 0, reset: false, errorStatus: null, keepRatio: null };
  for (const d of decisions) {
    switch (d.faultType) {
      case 'latency':
        plan.totalDelayMs += d.params.delayMs ?? 0;
        break;
      case 'connection_reset':
        plan.reset = true;
        break;
      case 'error_status':
        plan.errorStatus = d.params.statusCode ?? 503;
        break;
      case 'truncate':
        plan.keepRatio = d.params.keepRatio ?? 0.5;
        break;
    }
  }
  return plan;
}

export function truncateBody(body: Buffer, keepRatio: number): Buffer {
  const keep = Math.max(1, Math.floor(body.length * keepRatio));
  return body.subarray(0, keep);
}