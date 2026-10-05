import { setTimeout as delay } from 'node:timers/promises';
import { ServiceError } from '../contract/errors.ts';
import type { TestExecutor } from '../contract/types.ts';

// Built-in executor patterns, mainly for demo/acceptance. Real adapters
// (e.g. spawning a test command) implement the same TestExecutor contract.
export const PATTERNS = ['always-pass', 'always-fail', 'alternate', 'slow-pass', 'broken-executor'] as const;
export type PatternName = (typeof PATTERNS)[number];

export function executorFor(pattern: string): TestExecutor {
  switch (pattern) {
    case 'always-pass':
      return () => 'pass';
    case 'always-fail':
      return () => 'fail';
    case 'alternate':
      // odd runs pass, even runs fail => first failure at run #2
      return (i) => (i % 2 === 1 ? 'pass' : 'fail');
    case 'slow-pass':
      // 20ms per run; used to exercise the STATE_CONFLICT path
      return async () => {
        await delay(20);
        return 'pass' as const;
      };
    case 'broken-executor':
      // violates the executor contract; the kernel must raise COMPUTATION_FAILED
      return () => 'maybe' as unknown as 'pass';
    default:
      throw new ServiceError('INPUT_ERROR', `unknown pattern '${pattern}'`, { known: PATTERNS });
  }
}
