import { VirtualClock } from "../src/clock.ts";
import { AesGcmCipher } from "../src/crypto.ts";
import { SqliteStore } from "../src/store.ts";
import { VaultCore } from "../src/core.ts";

export const TEST_KEY = "a".repeat(64);

export function makeVault(gracePeriodMs = 60_000, startMs = 1_700_000_000_000) {
  const clock = new VirtualClock(startMs);
  const store = new SqliteStore(":memory:");
  const cipher = new AesGcmCipher(TEST_KEY);
  const runId = "test-run-1";
  const core = new VaultCore({ store, cipher, clock, gracePeriodMs, runId });
  return { clock, store, cipher, core, runId };
}
