import type { RenewalAction } from '../domain/types.js';

export interface RenewalPolicy {
  renewSoonDays: number;
  renewImmediatelyDays: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function remainingDays(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS);
}

export function renewalActionFor(remaining: number, policy: RenewalPolicy): RenewalAction {
  if (remaining < 0) return 'RENEW_IMMEDIATELY';
  if (remaining <= policy.renewImmediatelyDays) return 'RENEW_IMMEDIATELY';
  if (remaining <= policy.renewSoonDays) return 'RENEW_SOON';
  return 'NONE';
}

