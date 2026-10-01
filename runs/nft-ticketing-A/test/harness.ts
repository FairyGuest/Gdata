import { Kernel } from "../src/kernel/kernel.ts";
import type { Command, CommandResult } from "../src/contract/types.ts";

/**
 * Deterministic concurrent-run harness.
 *
 * It shuffles request *order* with a fixed permutation, but adjudication is
 * decided by the kernel's transaction commit sequence (commit_log), not by the
 * arrival order or any wall-clock timestamp. Both requests still run through
 * independent transactions against the same ledger.
 */
export function runConcurrent(
  kernel: Kernel,
  commands: Command[],
  order: number[],
): CommandResult[] {
  const results: CommandResult[] = [];
  for (const idx of order) {
    results.push(kernel.execute(commands[idx]));
  }
  return results.sort((a, b) => a.commitSeq - b.commitSeq);
}

/** Fixed permutation: buyer B is submitted "first" to prove arrival order loses. */
export const FIXED_RIVAL_ORDER = [1, 0];
