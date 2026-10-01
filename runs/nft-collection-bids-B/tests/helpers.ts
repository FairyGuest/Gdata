import { buildApp, type BuiltApp } from "../src/server.js";
import type { KernelHooks } from "../src/kernel/engine.js";
import type { ServiceConfig } from "../src/config.js";

export const TEST_SEED = 20261001;

export function makeApp(hooks: KernelHooks = {}, runId = "test-run"): BuiltApp {
  const config: ServiceConfig = {
    dbPath: ":memory:",
    seed: TEST_SEED,
    port: "0",
    runId,
  };
  return buildApp(config, hooks);
}

export interface InjectResult {
  status: number;
  body: Record<string, any>;
}

export async function call(
  built: BuiltApp,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectResult> {
  const res = await built.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

export async function createBid(
  built: BuiltApp,
  bidderId: string,
  collectionId: string,
  price: number,
): Promise<InjectResult> {
  return call(built, "POST", "/bids", { bidderId, collectionId, price });
}