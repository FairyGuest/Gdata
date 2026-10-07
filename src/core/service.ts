// Orchestration kernel: parse -> merge -> diff -> persist. This is the
// single entry point used by both the HTTP adapter and the test suite.

import { randomUUID } from "node:crypto";
import { AppError, inputError } from "../contracts/errors.ts";
import type { DriftInput, DriftOutput, JsonValue, LayerSet, RunRecord } from "../contracts/types.ts";
import { LAYER_NAMES } from "../contracts/types.ts";
import { mergeLayers } from "./merge.ts";
import type { MergeTrace } from "./merge.ts";
import { diffConfigs } from "./drift.ts";
import { RunStore } from "../state/store.ts";

export interface ServiceLogger {
  info(event: string, fields: Record<string, unknown>): void;
}

export const consoleLogger: ServiceLogger = {
  info(event, fields) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDriftInput(body: unknown): DriftInput {
  if (!isRecord(body)) throw inputError("request body must be a JSON object");
  const env = body["env"];
  if (typeof env !== "string" || env.trim() === "") {
    throw inputError('field "env" must be a non-empty string', { field: "env" });
  }
  const layersRaw = body["layers"];
  if (!isRecord(layersRaw)) {
    throw inputError('field "layers" must be an object with keys base/env/instance', { field: "layers" });
  }
  const layers: Record<string, JsonValue> = {};
  for (const name of LAYER_NAMES) {
    if (!(name in layersRaw)) {
      throw inputError(`field "layers.${name}" is required`, { field: `layers.${name}` });
    }
    layers[name] = layersRaw[name] as JsonValue;
  }
  if (!("snapshot" in body)) {
    throw inputError('field "snapshot" is required', { field: "snapshot" });
  }
  return { env, layers: layers as unknown as LayerSet, snapshot: body["snapshot"] as JsonValue };
}

export class DriftService {
  private store: RunStore;
  private logger: ServiceLogger;

  constructor(store: RunStore, logger: ServiceLogger = consoleLogger) {
    this.store = store;
    this.logger = logger;
  }

  runDriftCheck(input: DriftInput): DriftOutput {
    const runId = randomUUID();
    this.logger.info("run.start", { runId, env: input.env });
    const { effective, trace } = mergeLayers(input.layers);
    this.logger.info("run.merged", {
      runId,
      env: input.env,
      trace: trace.map((t: MergeTrace) => `${t.layer}:${t.keysAfterMerge}`).join(","),
      reason: "cascade merge base->env->instance completed",
    });
    const report = diffConfigs(effective, input.snapshot, input.env);
    this.logger.info("run.diffed", {
      runId,
      env: input.env,
      status: report.status,
      counts: report.counts,
      reason: report.status === "PASS" ? "no structural differences" : "differences classified by severity",
    });
    const output: DriftOutput = { runId, merge: { env: input.env, effective }, report };
    this.store.saveRun(input, output);
    this.logger.info("run.persisted", { runId, env: input.env });
    return output;
  }

  replay(runId: string, env?: string): RunRecord {
    const record = this.store.getRun(runId);
    if (env !== undefined && record.env !== env) {
      throw new AppError("STATE_CONFLICT", `run "${runId}" belongs to env "${record.env}", not "${env}"`, {
        runId, expectedEnv: record.env, givenEnv: env,
      });
    }
    return record;
  }

  close(): void {
    this.store.close();
  }

  listRuns(env?: string) {
    return this.store.listRuns(env);
  }
}
