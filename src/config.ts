import { readFileSync, existsSync } from "node:fs";
import { inputError } from "./contract/errors.ts";

export interface RunnerConfig {
  host: string;
  port: number;
  /** Default glob pattern for test file discovery. */
  pattern: string;
  /** Default per-case timeout, ms. */
  timeoutMs: number;
  /** Default max concurrent cases. */
  parallel: number;
  /** Hard upper bound for `parallel`. */
  maxParallel: number;
  /** Max simultaneous /runs requests; excess gets 503 RESOURCE_EXHAUSTED. */
  maxConcurrentRuns: number;
  /** SQLite file path (":memory:" allowed). */
  dbPath: string;
}

export const defaultConfig: RunnerConfig = {
  host: "127.0.0.1",
  port: 3100,
  pattern: "**/*.test.js",
  timeoutMs: 5000,
  parallel: 4,
  maxParallel: 16,
  maxConcurrentRuns: 4,
  dbPath: "data/results.db",
};

/** Load config: defaults < JSON file < environment variables. */
export function loadConfig(configPath?: string, env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  let fileCfg: Partial<RunnerConfig> = {};
  const p = configPath ?? env.TEST_RUNNER_CONFIG ?? "config/runner.json";
  if (p && existsSync(p)) {
    try {
      fileCfg = JSON.parse(readFileSync(p, "utf8")) as Partial<RunnerConfig>;
    } catch (err) {
      throw inputError("invalid config file " + p + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }
  const cfg: RunnerConfig = { ...defaultConfig, ...fileCfg };
  if (env.TEST_RUNNER_PORT) cfg.port = Number(env.TEST_RUNNER_PORT);
  if (env.TEST_RUNNER_HOST) cfg.host = env.TEST_RUNNER_HOST;
  if (env.TEST_RUNNER_DB) cfg.dbPath = env.TEST_RUNNER_DB;
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw inputError("invalid port: " + String(cfg.port));
  }
  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 1) {
    throw inputError("invalid timeoutMs: " + String(cfg.timeoutMs));
  }
  return cfg;
}
