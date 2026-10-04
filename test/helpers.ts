import { VirtualClock } from "../src/clock.ts";
import { QuotaKernel } from "../src/kernel.ts";
import { RunLogger } from "../src/logger.ts";
import { Store } from "../src/store.ts";

export interface Fixture {
  store: Store;
  clock: VirtualClock;
  kernel: QuotaKernel;
  logger: RunLogger;
}

export function makeFixture(limits: { global: number; org: number; project: number }, key = "ak_test"): Fixture {
  const store = new Store(":memory:");
  const clock = new VirtualClock();
  const logger = new RunLogger("test-run");
  const kernel = new QuotaKernel(store, clock, logger);
  kernel.provisionKey({
    key,
    scopes: [
      { tier: "global", id: "g1", limit: limits.global },
      { tier: "org", id: "o1", limit: limits.org },
      { tier: "project", id: "p1", limit: limits.project },
    ],
  });
  return { store, clock, kernel, logger };
}

export function throwsApp(fn: () => unknown): import("../src/errors.ts").AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error && err.name === "AppError") return err as import("../src/errors.ts").AppError;
    throw err;
  }
  throw new Error("expected function to throw an AppError, but it did not throw");
}

